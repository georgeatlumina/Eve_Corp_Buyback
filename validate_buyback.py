import json
from colorama import Fore, Back, Style, init
# from api_buyback import get_name_from_id as fetchName
import requests
import re
import time
# Initialize colorama
init(autoreset=True)
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
from janice_validation import scrape_evaluation_page as janice_check

fort_id = 1234     
drill_id = 1234
uuh_id = 1234
# Function to check if contract location matches the required location based on 'ore' presence
def check_price(contract_price,buy_value):
    if contract_price == buy_value:
        colored_print("OK",color="Green")
    else:
        
        if abs(contract_price - buy_value) <= 1:
            colored_print("OK, Abs within 1",color="Green")
        else:
            colored_print("Mismatch",color="Red")
            print("Contract price:")
            print(contract_price)
            print("Janice price:")
            print(buy_value)
def check_contract_location(df, contract_location_id):
    """
    Check if the contract's location matches the given location variables based on 'ore' presence in the DataFrame.
    
    Args:
        df (pd.DataFrame): The DataFrame of items containing the materials and location data.
        contract_location_id (int): The contract's current location ID to check.

    Returns:
        bool: True if the contract location matches the required location based on the presence of 'ore',
              False otherwise.
    """
    if contract_location_id == fort_id or contract_location_id == drill_id or contract_location_id == uuh_id:
        contains_ore = df.iloc[:, 1].str.contains('ore|compressed', case=False, na=False).any()
        if contains_ore:
            print("Contains Ore")
            print("In Drill?")
            if contract_location_id == drill_id:
                colored_print(contract_location_id == drill_id,color="Green")
                
                return
            else:
                colored_print(contract_location_id == drill_id, color="Red")
            print("In UUH?")
            if contract_location_id == uuh_id:
            
                colored_print(contract_location_id == uuh_id, color="Green")
                return
            else:
                colored_print(contract_location_id == uuh_id, color="Red")
            return 
        print("In Fort?")
        if contract_location_id == fort_id:
            colored_print(contract_location_id == fort_id,color="Green")
            return 
        else:
            colored_print(contract_location_id == fort_id,color="Red")
        print("In UUH?")
        if contract_location_id == uuh_id:
            
            colored_print(contract_location_id == uuh_id, color="Green")
            return
        else:
            colored_print(contract_location_id == uuh_id, color="Red")

    else:
        colored_print("Not in any servicable station",color="Red")
        return 
    # # Check if 'ore' exists in the DataFrame (any material column or specific column that indicates "ore")
    

    # # If 'ore' exists, contract location should match 'drill_id' or 'uuh_id'
    # if contains_ore:
    #     return contract_location_id in [drill_id, uuh_id]
    # else:
    #     # If 'ore' does not exist, contract location should match 'uuh_id' or 'fort_id'
    #     return contract_location_id in [uuh_id, fort_id]

def colored_print(text, color='WHITE', background=None, style=None):
    """
    Prints the provided text in a specified color, background, and style.
    
    Parameters:
    - text: The text to print.
    - color: Text color (default is 'WHITE').
    - background: Background color (optional).
    - style: Text style (optional, e.g., 'BRIGHT', 'DIM', etc.).
    """
    color_dict = {
        'BLACK': Fore.BLACK,
        'RED': Fore.RED,
        'GREEN': Fore.GREEN,
        'YELLOW': Fore.YELLOW,
        'BLUE': Fore.BLUE,
        'MAGENTA': Fore.MAGENTA,
        'CYAN': Fore.CYAN,
        'WHITE': Fore.WHITE,
        'RESET': Fore.RESET
    }

    background_dict = {
        'BLACK': Back.BLACK,
        'RED': Back.RED,
        'GREEN': Back.GREEN,
        'YELLOW': Back.YELLOW,
        'BLUE': Back.BLUE,
        'MAGENTA': Back.MAGENTA,
        'CYAN': Back.CYAN,
        'WHITE': Back.WHITE,
        'RESET': Back.RESET
    }

    style_dict = {
        'BRIGHT': Style.BRIGHT,
        'DIM': Style.DIM,
        'NORMAL': Style.NORMAL
    }
    
    # Apply the color, background, and style
    text_color = color_dict.get(color.upper(), Fore.WHITE)
    background_color = background_dict.get(background.upper(), Back.RESET) if background else Back.RESET
    text_style = style_dict.get(style.upper(), Style.NORMAL) if style else Style.NORMAL

    # Print the text with the selected color, background, and style
    print(f"{text_color}{background_color}{text_style}{text}")
# Load the JSON data from the file
with open('contracts.json', 'r') as file:
    data = json.load(file)
def janice_exists(contracts):
    for contract in contracts:
        # Check if the URL contains the word 'janice'
        if 'janice' in contract['title']:
            # Print success in green
            colored_print(f"Contract ID {contract['contract_id']} passed URL validation (contains 'janice').", color='GREEN')
            # Proceed to the next step of validation (placeholder)
            colored_print(f"Validating further for Contract ID {contract['contract_id']}: {contract['title']}", color='CYAN')
            return True
            
        else:
            # Print failure in red
            colored_print(f"Contract ID {contract['contract_id']} failed URL validation (does not contain 'janice'). Title: {contract['title']} for amount: {contract['price']}", color='RED')

            return False
            

# Define a function to filter the data
def filter_contracts(data, **filters):
    """
    Filters the JSON data based on arbitrary keyword arguments.

    Parameters:
    - data: list of dictionaries (JSON data).
    - filters: arbitrary filter conditions (key-value pairs).

    Returns:
    - Filtered data as a list of dictionaries.
    """
    filtered_data = []
    for contract in data:
        # Check if all conditions in filters match the contract
        if all(contract.get(key) == value for key, value in filters.items()):
            filtered_data.append(contract)
    return filtered_data
def is_appraisal_valid(appraisal_text):
    """
    Check if the appraisal text contains a percentage of 90% or less.

    Args:
        appraisal_text (str): The appraisal text to check.

    Returns:
        bool: True if the percentage is 90% or less, False otherwise.
    """
    # Find all percentage values in the appraisal text
    percentages = re.findall(r'(\d+)%', appraisal_text)
    
    # Convert to integers and check if any percentage is <= 90
    for value in percentages:
        if int(value) <= 90:
            return True
    return False
# Example: Define the filters
# filters = {
#     # "availability": "personal",
#     "assignee_id": 98535184,
#     "status": "outstanding" ,
#     "type" : "item_exchange" # Add or remove keys as needed
# }
courier_filters = {
    "type": "courier",  # Filter for courier contracts
    "assignee_id": 123,
    "status": "outstanding",

}
moon_filters = {
    "price": 0,  # Filter for moon contracts where price is 0
    "type": "item_exchange",  # Filter for buyback contracts
    "assignee_id": 123,  # Filter for specific assignee_id
    "status": "outstanding",
}
buyback_filters = {
    "type": "item_exchange",  # Filter for buyback contracts
    "assignee_id": 123,  # Filter for specific assignee_id
    "status": "outstanding",
}

# # Apply the filters
# filtered_contracts = filter_contracts(data, **filters)

# # Save the filtered data to a new JSON file
# output_path = 'filtered_contracts.json'
# with open(output_path, 'w') as outfile:
#     json.dump(filtered_contracts, outfile, indent=4)

# print(f"Filtered data saved to {output_path}")


# Apply the filters for courier contracts
courier_contracts = filter_contracts(data, **courier_filters)

# Save the filtered courier contracts to a new JSON file
courier_output_path = 'courier_contracts.json'
with open(courier_output_path, 'w') as outfile:
    json.dump(courier_contracts, outfile, indent=4)

print(f"Courier contracts have been saved to {courier_output_path}")


# Apply the filters for moon contracts
moon_contracts = filter_contracts(data, **moon_filters)

# Save the filtered moon contracts to a new JSON file
moon_output_path = 'moon_contracts.json'
with open(moon_output_path, 'w') as outfile:
    json.dump(moon_contracts, outfile, indent=4)

print(f"Moon contracts have been saved to {moon_output_path}")

# Filter out courier and moon contracts from the original data
remaining_data = [contract for contract in data if contract not in courier_contracts and contract not in moon_contracts]


# Apply the filters for buyback contracts
buyback_contracts = filter_contracts(remaining_data, **buyback_filters)

# Save the filtered buyback contracts to a new JSON file
buyback_output_path = 'buyback_contracts.json'
with open(buyback_output_path, 'w') as outfile:
    json.dump(buyback_contracts, outfile, indent=4)

print(f"Buyback contracts have been saved to {buyback_output_path}")
print()
colored_print(f"Number of buyback contracts: {len(buyback_contracts)}", color="GREEN", background="Red")
print()
janice_exists(buyback_contracts)
print()
for contract in buyback_contracts:
        if 'janice' in contract['title']:
            url = contract['title']
            
            # Call the function to check the appraisal warning for each URL
            [appraisal_text, buy_value, table_df] = janice_check(url)

            if appraisal_text and is_appraisal_valid(appraisal_text):
                
                
                
                
                
                colored_print(f"Contract ID {contract['contract_id']} with Price = {contract['price']} passed URL validation (valid appraisal: {url})", color='GREEN')
                print("Appraisal Text is valid:", appraisal_text)
                print("Buy Value:", buy_value)
                print("\nTable Data:")
                print(table_df)
                print("Checking Location")
                print()

                check_contract_location(table_df,contract["start_location_id"])
                cleaned_value = round(float(re.sub(r"[^\d.]", "", buy_value)))

                print("Price Check")
                check_price(round(contract["price"]),cleaned_value)



            else:
                colored_print(f"Contract ID {contract['contract_id']} with Price = {contract['price']} failed URL validation (invalid appraisal: {url})", color='RED')
                print("Appraisal Text is invalid or does not contain a valid percentage (<= 90%).")
        


    # # Print a colored message based on the result
    # if is_valid:
    #     colored_print(f"Contract ID {contract['contract_id']} passed URL validation (valid appraisal: {url})", color='GREEN')
    # else:
    #     colored_print(f"Contract ID {contract['contract_id']} failed URL validation (invalid appraisal: {url})", color='RED')
