import re

from janice import fetch_appraisal


def filter_contracts(contracts, **conditions):
    return [c for c in contracts if all(c.get(k) == v for k, v in conditions.items())]


def categorize(contracts, corp_id):
    courier = filter_contracts(
        contracts, type='courier', assignee_id=corp_id, status='outstanding',
    )
    moon = filter_contracts(
        contracts, price=0, type='item_exchange', assignee_id=corp_id, status='outstanding',
    )
    courier_ids = {id(c) for c in courier}
    moon_ids = {id(c) for c in moon}
    remaining = [c for c in contracts if id(c) not in courier_ids and id(c) not in moon_ids]
    buyback = filter_contracts(
        remaining, type='item_exchange', assignee_id=corp_id, status='outstanding',
    )
    return {'courier': courier, 'moon': moon, 'buyback': buyback}


def _category(items):
    return 'ore' if any(i['is_ore'] for i in items) else 'non-ore'


def validate_buyback_contract(contract, structures, janice_market='', janice_api_key=None):
    title = contract.get('title') or ''
    result = {
        'contract_id': contract.get('contract_id'),
        'title': title,
        'price': contract.get('price'),
        'start_location_id': contract.get('start_location_id'),
        'issuer_id': contract.get('issuer_id'),
        'checks': {},
    }

    if 'janice' not in title.lower():
        result['checks']['janice_url'] = {
            'pass': False,
            'reason': 'Title does not contain a Janice URL',
        }
        return result
    result['checks']['janice_url'] = {'pass': True, 'reason': ''}

    try:
        appraisal = fetch_appraisal(title, api_key=janice_api_key)
    except Exception as e:
        result['checks']['appraisal_fetch'] = {'pass': False, 'reason': str(e)}
        return result

    pct = appraisal['percentage']
    result['appraisal'] = {
        'percentage': pct,
        'effective_offer': appraisal['effective_offer'],
        'total_buy_price': appraisal['total_buy_price'],
        'market_name': appraisal['market_name'],
        'source': appraisal.get('source', 'api'),
        'api_fallback_reason': appraisal.get('api_fallback_reason'),
        'items': appraisal.get('items', []),
    }

    if janice_market:
        market_name = appraisal['market_name'] or ''
        # Substring match so "Jita" matches "Jita 4-4", "Jita IV-IV", etc.
        token = janice_market.split()[0].lower()
        ok = token in market_name.lower()
        result['checks']['market'] = {
            'pass': ok,
            'reason': f'expected market matching {janice_market!r}, got {market_name!r}',
        }

    result['checks']['appraisal_percentage'] = {
        'pass': pct <= 90,
        'reason': f'{pct:.1f}% (must be <= 90%)',
    }

    contract_price = round(float(contract.get('price') or 0))
    expected = round(appraisal['effective_offer'])
    result['checks']['price'] = {
        'pass': abs(contract_price - expected) <= 1,
        'reason': f'contract={contract_price} vs janice={expected}',
    }

    if appraisal['items']:
        category = _category(appraisal['items'])
        loc_id = contract.get('start_location_id')
        matching = [s for s in structures if s.get('id') and category in (s.get('accepts') or [])]
        valid_ids = {s['id'] for s in matching}
        matched = next((s for s in matching if s['id'] == loc_id), None)
        if matched:
            reason = f'OK in {matched["name"]} (accepts {category})'
        else:
            names = ', '.join(f'{s["name"]} ({s["id"]})' for s in matching) or '(no structures accept this category)'
            reason = f'category={category}; expected one of: {names}; got location_id={loc_id}'
        result['checks']['location'] = {
            'pass': loc_id in valid_ids,
            'reason': reason,
        }

    return result


def process_moon_contract(contract, structures, payout_lookup):
    """Compute the recommended moon payout and flag any 'return' annotation in the title."""
    title = contract.get('title') or ''
    result = {
        'contract_id': contract.get('contract_id'),
        'title': title,
        'price': contract.get('price'),
        'start_location_id': contract.get('start_location_id'),
        'issuer_id': contract.get('issuer_id'),
        'checks': {},
        'flags': [],
    }

    if re.search(r'\breturn\b', title, re.IGNORECASE):
        result['flags'].append('return_requested')

    try:
        payout = payout_lookup(contract)
        result['payout'] = payout
        if payout.get('has_donations'):
            result['flags'].append('workforce_donation')
        if payout.get('has_prismaticite'):
            result['flags'].append('prismaticite_manual')
        bad = payout.get('mineable_bad') or []
        if bad:
            names = sorted({i.get('name') or f'type {i["type_id"]}' for i in bad})
            preview = ', '.join(names[:8])
            if len(names) > 8:
                preview += f', …(+{len(names) - 8} more)'
            result['checks']['mineable_only'] = {
                'pass': False,
                'reason': f'Contains non-ore/moon/ice/reagent items: {preview}',
            }
    except Exception as e:
        result['checks']['payout'] = {'pass': False, 'reason': f'Could not compute payout: {e}'}

    return result


def validate_all(
    contracts, corp_id, structures,
    janice_market='', janice_api_key=None,
    moon_payout_lookup=None,
):
    buckets = categorize(contracts, corp_id)
    buyback_results = [
        validate_buyback_contract(c, structures, janice_market, janice_api_key)
        for c in buckets['buyback']
    ]
    moon_results = []
    if moon_payout_lookup is not None:
        moon_results = [
            process_moon_contract(c, structures, moon_payout_lookup)
            for c in buckets['moon']
        ]
    return {
        'summary': {
            'courier': len(buckets['courier']),
            'moon': len(buckets['moon']),
            'buyback': len(buckets['buyback']),
        },
        'buyback_results': buyback_results,
        'moon_results': moon_results,
    }
