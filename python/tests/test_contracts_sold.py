"""Unit tests for _filter_sold_contracts and _matches_quota (sold-30-days feature)."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

CORP_ID = 1000001
STRUCTURE_ID = 99000001
CUTOFF = '2026-05-17T00:00:00+00:00'  # 30 days before 2026-06-16


def _contract(
    contract_id=1,
    status='finished',
    type_='item_exchange',
    structure_id=STRUCTURE_ID,
    corp_id=CORP_ID,
    date_completed='2026-06-01T12:00:00+00:00',
    title='Naga Mk1',
):
    return {
        'contract_id': contract_id,
        'status': status,
        'type': type_,
        'start_location_id': structure_id,
        'issuer_corporation_id': corp_id,
        'date_completed': date_completed,
        'title': title,
    }


class TestFilterSoldContracts:
    def test_passes_valid_contract(self):
        from server import _filter_sold_contracts
        result = _filter_sold_contracts([_contract()], CORP_ID, STRUCTURE_ID, CUTOFF)
        assert len(result) == 1

    def test_rejects_wrong_status(self):
        from server import _filter_sold_contracts
        result = _filter_sold_contracts([_contract(status='outstanding')], CORP_ID, STRUCTURE_ID, CUTOFF)
        assert result == []

    def test_rejects_wrong_type(self):
        from server import _filter_sold_contracts
        result = _filter_sold_contracts([_contract(type_='auction')], CORP_ID, STRUCTURE_ID, CUTOFF)
        assert result == []

    def test_rejects_wrong_structure(self):
        from server import _filter_sold_contracts
        result = _filter_sold_contracts([_contract(structure_id=99999999)], CORP_ID, STRUCTURE_ID, CUTOFF)
        assert result == []

    def test_rejects_wrong_corp(self):
        from server import _filter_sold_contracts
        result = _filter_sold_contracts([_contract(corp_id=9999999)], CORP_ID, STRUCTURE_ID, CUTOFF)
        assert result == []

    def test_rejects_completed_before_cutoff(self):
        from server import _filter_sold_contracts
        result = _filter_sold_contracts(
            [_contract(date_completed='2026-05-01T00:00:00+00:00')], CORP_ID, STRUCTURE_ID, CUTOFF
        )
        assert result == []

    def test_accepts_completed_exactly_at_cutoff(self):
        from server import _filter_sold_contracts
        result = _filter_sold_contracts(
            [_contract(date_completed=CUTOFF)], CORP_ID, STRUCTURE_ID, CUTOFF
        )
        assert len(result) == 1

    def test_deduplicates_by_contract_id(self):
        from server import _filter_sold_contracts
        contracts = [_contract(contract_id=1), _contract(contract_id=1)]
        result = _filter_sold_contracts(contracts, CORP_ID, STRUCTURE_ID, CUTOFF)
        assert len(result) == 1

    def test_multiple_valid_contracts(self):
        from server import _filter_sold_contracts
        contracts = [_contract(contract_id=1), _contract(contract_id=2), _contract(contract_id=3)]
        result = _filter_sold_contracts(contracts, CORP_ID, STRUCTURE_ID, CUTOFF)
        assert len(result) == 3

    def test_mixed_valid_and_invalid(self):
        from server import _filter_sold_contracts
        contracts = [
            _contract(contract_id=1),
            _contract(contract_id=2, status='outstanding'),
            _contract(contract_id=3, date_completed='2026-04-01T00:00:00+00:00'),
            _contract(contract_id=4),
        ]
        result = _filter_sold_contracts(contracts, CORP_ID, STRUCTURE_ID, CUTOFF)
        assert len(result) == 2
        assert {c['contract_id'] for c in result} == {1, 4}

    def test_empty_input(self):
        from server import _filter_sold_contracts
        assert _filter_sold_contracts([], CORP_ID, STRUCTURE_ID, CUTOFF) == []

    def test_missing_date_completed_rejected(self):
        from server import _filter_sold_contracts
        c = _contract()
        c['date_completed'] = None
        result = _filter_sold_contracts([c], CORP_ID, STRUCTURE_ID, CUTOFF)
        assert result == []


class TestMatchesQuotaForSold:
    def _quota(self, ship_type_id=123, title_filter=''):
        return {'ship_type_id': ship_type_id, 'title_filter': title_filter}

    def _items(self, type_id, qty=1, is_included=True):
        return [{'type_id': type_id, 'quantity': qty, 'is_included': is_included, 'name': ''}]

    def test_matches_ship_type(self):
        from server import _matches_quota
        q = self._quota(ship_type_id=123)
        assert _matches_quota(q, self._items(123), {'title': ''}) == 1

    def test_no_match_wrong_type(self):
        from server import _matches_quota
        q = self._quota(ship_type_id=123)
        assert _matches_quota(q, self._items(456), {'title': ''}) == 0

    def test_counts_quantity(self):
        from server import _matches_quota
        q = self._quota(ship_type_id=123)
        assert _matches_quota(q, self._items(123, qty=3), {'title': ''}) == 3

    def test_title_filter_match(self):
        from server import _matches_quota
        q = self._quota(ship_type_id=123, title_filter='Mk1')
        assert _matches_quota(q, self._items(123), {'title': 'Naga Mk1'}) == 1

    def test_title_filter_no_match(self):
        from server import _matches_quota
        q = self._quota(ship_type_id=123, title_filter='Mk2')
        assert _matches_quota(q, self._items(123), {'title': 'Naga Mk1'}) == 0

    def test_excluded_items_not_counted(self):
        from server import _matches_quota
        q = self._quota(ship_type_id=123)
        items = [{'type_id': 123, 'quantity': 1, 'is_included': False, 'name': ''}]
        assert _matches_quota(q, items, {'title': ''}) == 0

    def test_zero_ship_type_id_returns_zero(self):
        from server import _matches_quota
        q = self._quota(ship_type_id=0)
        assert _matches_quota(q, self._items(0), {'title': ''}) == 0
