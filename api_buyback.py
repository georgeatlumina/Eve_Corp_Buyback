from esipy import EsiApp
from esipy import EsiClient
from esipy import EsiSecurity
import platform
import random
import hmac
import hashlib
import requests
import os
import json

from esipy.events import AFTER_TOKEN_REFRESH

filter_conditions = {
        "availability": "outstanding",
        "assignee_id": "",  # Example corp ID
        # Add other filters as needed, e.g., "issuer_id": 12345678
}




secret_key = os.urandom(24)
nldo_id = ''
spec_url = "https://esi.tech.ccp.is/latest/swagger.json"
# Define the characters to use for the random string
chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

# Use a cryptographically secure random number generator
rand = random.SystemRandom()

# Generate a 40-character random string
random_string = ''.join(rand.choice(chars) for _ in range(40))
def apply_filters(data, filters):
        filtered_data = []
        for item in data:
            if all(item.get(key) == value for key, value in filters.items() if value is not None):
                filtered_data.append(item)
        return filtered_data
def generate_token():
    """Generates a non-guessable OAuth token"""
    chars = ('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    rand = random.SystemRandom()
    random_string = ''.join(rand.choice(chars) for _ in range(40))
    return hmac.new(
        secret_key,
        random_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
token = generate_token()
print(token)
def generate_user_agent(app_name="buyback_validater", version="1.0"):
    """
    Generates a user-agent string for API requests.
    
    Args:
        app_name (str): Name of the application.
        version (str): Version of the application.

    Returns:
        str: A custom user-agent string.
    """
    os_name = platform.system()  # Operating System name
    os_version = platform.release()  # OS version
    python_version = platform.python_version()  # Python version

    user_agent = f"{app_name}/{version} ({os_name} {os_version}; Python {python_version})"
    return user_agent
def after_token_refresh_hook(access_token, refresh_token, expires_in, **kwargs):
	print ("We got new token: %s" % access_token)
	print ("refresh token used: %s" % refresh_token)
	print ("Expires in %d" % expires_in)
# Example usage
custom_user_agent = generate_user_agent(app_name="EVEApp", version="1.0.0")
print(custom_user_agent)


app = EsiApp().get_latest_swagger

# replace the redirect_uri, client_id and secret_key values
# with the values you get from the STEP 1 !
security = EsiSecurity(
    redirect_uri='https://localhost:5000/sso/callback',
    client_id='',
    secret_key='',
    headers={custom_user_agent: 'Buyback'},
)

# and the client object, replace the header user agent value with something reliable !
client = EsiClient(
    retry_requests=True,
    headers={custom_user_agent: 'Buyback'},
    security=security
)

# print (security.get_auth_uri(state=token, scopes=['publicData esi-markets.structure_markets.v1 esi-wallet.read_corporation_wallets.v1 esi-contracts.read_corporation_contracts.v1']))

security.update_token({
    'access_token': '',  # leave this empty
    'expires_in': -1,  # seconds until expiry, so we force refresh anyway
    'refresh_token': '=='
})


tokens = security.refresh()
print(tokens)
# print(tokens['access_token'])
api_info = security.verify()
print('/n')
print(api_info)
print('Access token:')
print(security.access_token)
newtoken = security.access_token
# AFTER_TOKEN_REFRESH.add_receiver(after_token_refresh_hook)



op = app.op['get_corporations_corporation_id_contracts'](
    corporation_id = '',
    # datasource = 'tranquility',
    token = newtoken,
# type = "item_exchange",
# assignee_id = "98535184",
# status = "outstanding"
)



# URL and parameters
url = "https://esi.evetech.net/latest/corporations/98535184/contracts/"
headers = {
    "accept": "application/json",
    "authorization": security.access_token,
}
params = {
    "datasource": "tranquility",
    "token": security.access_token,
    "page": 1,
}
# response = requests.get(url, params=params)
# if response.status_code == 200:
#     print("Request succeeded!")
#     # print(response.json())  # If the response is JSON
#     data = response.json()
#     file_name = "contracts.json"

#     # Save JSON data to a file
#     with open(file_name, "w") as json_file:
#         json.dump(data, json_file, indent=4)

#     print(f"Data has been saved to {file_name}")


# else:
#     print(f"Request failed with status code {response.status_code}")
#     print(response.text)  # Print the error response

def fetch_and_save_api_data_with_pagination(url, headers, params, file_name):
    """
    Fetches data from an API page by page, saving the data until a 500 error is encountered.
    
    Args:
        url (str): API endpoint URL.
        headers (dict): Headers for the API request.
        params (dict): Parameters for the API request.
        file_name (str): Path to save the JSON response.
        
    Returns:
        bool: True if the operation succeeded, False otherwise.
    """
    page = 1
    all_data = []  # To store all the data from the pages

    while True:
        # Update the page parameter
        params['page'] = page
        
        try:
            # Make the GET request
            response = requests.get(url, params=params)
            
            if response.status_code == 200:
                print(f"Successfully fetched page {page}")
                data = response.json()
                all_data.extend(data)  # Add data to the list
                page += 1  # Move to the next page
                
            elif response.status_code == 500:
                print("Error 500 encountered. Stopping the pagination.")
                break  # Stop on error 500

            else:
                print(f"Request failed on page {page} with status code {response.status_code}")
                break  # Stop for other errors or unexpected status codes

        except Exception as e:
            print(f"An error occurred: {e}")
            break  # Stop on exception

    # Save the fetched data to a JSON file
    try:
        with open(file_name, "w") as json_file:
            json.dump(all_data, json_file, indent=4)
        print(f"Data has been saved to {file_name}")
        return True

    except Exception as e:
        print(f"Error saving data: {e}")
        return False

fetch_and_save_api_data_with_pagination(url, headers, params, 'contracts.json')

def get_name_from_id(url = 'https://esi.evetech.net/latest/universe/names/?datasource=tranquility', params = []):
    return requests.post(url,params = params)

# Filter for 'outstanding' availability and specific assignee_id
# corp_id = 98535184
# filtered_data = [item for item in response.json() if item.get('availability') == 'outstanding' and item.get('assignee_id') == corp_id]

# Print the filtered results
# for item in filtered_data:
#     print(item)


# contracts = client.request(op,headers=headers,params=params)
# print (contracts.data)

# tokens = security.auth('RRPR_xiPEEWf4jZIA8o1_w')
# print (tokens)

# print("pulling data")
# esi_data = requests.get('https://esi.evetech.net/latest/corporations/98535184/contracts/?datasource=tranquility')
# esi_data.status_code
# len(esi_data.content)
# print(esi_data.content)



# # URL and parameters
# url = "https://esi.evetech.net/latest/corporations/98535184/contracts/"
# headers = {
#     "accept": "application/json",
#     "authorization": security.access_token(secret_key),
# }
# params = {
#     "datasource": "tranquility",
#     "token": security.access_token(secret_key),
# }

# # Make the GET request
# response = requests.get(url, headers=headers, params=params)

# # Handle the response
# if response.status_code == 200:
#     print("Request succeeded!")
#     print(response.json())  # If the response is JSON
# else:
#     print(f"Request failed with status code {response.status_code}")
#     print(response.text)  # Print the error response

# curl -X GET "https://esi.evetech.net/latest/corporations/98535184/contracts/?datasource=tranquility&token=eyJhbGciOiJSUzI1NiIsImtpZCI6IkpXVC1TaWduYXR1cmUtS2V5IiwidHlwIjoiSldUIn0.eyJzY3AiOlsicHVibGljRGF0YSIsImVzaS1tYXJrZXRzLnN0cnVjdHVyZV9tYXJrZXRzLnYxIiwiZXNpLXdhbGxldC5yZWFkX2NvcnBvcmF0aW9uX3dhbGxldHMudjEiLCJlc2ktY29udHJhY3RzLnJlYWRfY29ycG9yYXRpb25fY29udHJhY3RzLnYxIl0sImp0aSI6IjhhMzE0ZGMxLWU5ZWQtNGQzNy04YTIzLWQ4YjllN2Q5NzMzYyIsImtpZCI6IkpXVC1TaWduYXR1cmUtS2V5Iiwic3ViIjoiQ0hBUkFDVEVSOkVWRToyMTIyNTE2Nzg0IiwiYXpwIjoiNjZjMzg5MDYxM2Q1NGQ0YWFkOTlmODg2MzNlNTk5NTEiLCJ0ZW5hbnQiOiJ0cmFucXVpbGl0eSIsInRpZXIiOiJsaXZlIiwicmVnaW9uIjoid29ybGQiLCJhdWQiOlsiNjZjMzg5MDYxM2Q1NGQ0YWFkOTlmODg2MzNlNTk5NTEiLCJFVkUgT25saW5lIl0sIm5hbWUiOiJzdXNoaWFuZHN1c2hpMiIsIm93bmVyIjoiZkdBN2dvV3UyT0FTc3hCSmk4aCtaYktTUjVNPSIsImV4cCI6MTczNDI3NTQxMiwiaWF0IjoxNzM0Mjc0MjEyLCJpc3MiOiJodHRwczovL2xvZ2luLmV2ZW9ubGluZS5jb20ifQ.jMV0txNbYYPDOLG9xuB4FzW3IfjAknoWPt3EG0TMiuKyd1DqSVvwNaU158aZPL5S4DCtY3wyY34YVFKRf9rS2xozgntqJ_00lhOTPbU4atyYdUdg0CeX4lH7OIgFE_eyfmYljsKl0O1Yhsa2F9318CSUT5wPJLJ_nJjUAjN03CEc-3V6sh1j-q3BFXI0Uvli8EudF-tdXCGierMMxqB1GKgRXPEt2KxoxBipeoF8sGDrXPkIvyOilp70bh557YkYtzLegDC3n4PMWuYyVn0mmmcWOkHVmwVxY5rQ7T9wiBYRVdqmOeBJ0iXhND1DUzZJCRgGjqKgVzOjhJktaD5WdQ" -H "accept: application/json" -H "authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IkpXVC1TaWduYXR1cmUtS2V5IiwidHlwIjoiSldUIn0.eyJzY3AiOiJlc2ktY29udHJhY3RzLnJlYWRfY29ycG9yYXRpb25fY29udHJhY3RzLnYxIiwianRpIjoiZjgzMWZlYTMtZTkxOS00OTJmLWJlMjgtNTEzNGM2OGQzMmRmIiwia2lkIjoiSldULVNpZ25hdHVyZS1LZXkiLCJzdWIiOiJDSEFSQUNURVI6RVZFOjIxMjI1MTY3ODQiLCJhenAiOiI2ODMwODRhYjVmODg0OGQ0YjE4NzQ2MmFjM2I5NzY3NyIsInRlbmFudCI6InRyYW5xdWlsaXR5IiwidGllciI6ImxpdmUiLCJyZWdpb24iOiJ3b3JsZCIsImF1ZCI6WyI2ODMwODRhYjVmODg0OGQ0YjE4NzQ2MmFjM2I5NzY3NyIsIkVWRSBPbmxpbmUiXSwibmFtZSI6InN1c2hpYW5kc3VzaGkyIiwib3duZXIiOiJmR0E3Z29XdTJPQVNzeEJKaThoK1piS1NSNU09IiwiZXhwIjoxNzM0MjczODk3LCJpYXQiOjE3MzQyNzI2OTcsImlzcyI6Imh0dHBzOi8vbG9naW4uZXZlb25saW5lLmNvbSJ9.ah9A07pykBYdTjq0aV67e2i_XjdACZD7-8QONaMMHjeZVO5cXgEAy0jRUPBW4VoEn03yEO6ABykmLiPgMJjsur2Mrzsx2Qv0CImBIANm7MHi05XbWP4s8nWrdJ4C5eJbftNP6T8bIxtfKK4Nap6BjXrMSbE2EhK36Sfs6Z7libLKOJxKiNhgpp_QxRWOHvNIw4QcDFs4d6snciUmRQmLa1enMYzzbfiHIXLpyIgageJQ2SJVtNxSQxPISzy62LbIcmKn7XgYS4TlVbQuq3x8g_PjZJ3xx53S101FCyggC2x1vTKhOU-WuV5hQAbt0aQrNBTv-mnfdIG3p-W_vWbigQ" -H "Cache-Control: no-cache"
# https://localhost:5000/sso/callback?code=RRPR_xiPEEWf4jZIA8o1_w&state=f42f6c148509ce9a0c519c33eb99c4ea7002595a2352fdf370fd7d3b1159e388

# https://localhost:5000/sso/callback?code=Z3SwRHLJVUKsCMiQ4GxSmw&state=a8fce6e8b0ae98454f8022ac8f48e5b211739b79bd370e1fd930eb775f4eb6f6