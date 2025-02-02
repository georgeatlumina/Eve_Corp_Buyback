
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
import pandas as pd
import time
# Set up Selenium with headless Chrome
chrome_options = Options()
chrome_options.add_argument("--headless")  # Run Chrome in headless mode
chrome_options.add_argument("--disable-gpu")
chrome_options.add_argument("--window-size=1920,1080")
# Initialize the WebDriver
service = Service(ChromeDriverManager().install())
driver = webdriver.Chrome(service=service, options=chrome_options)

# try:
#     # Load the webpage
#     url = "https://janice.e-351.com/a/oSCL9B"
#     driver.get(url)

#     # Wait until the page has loaded completely
#     wait = WebDriverWait(driver, 15)
#     wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))

#     # Extract the rendered page source
#     rendered_html = driver.page_source
#     # print(rendered_html)
#     # Parse the HTML with BeautifulSoup
#     soup = BeautifulSoup(rendered_html, "html.parser")

#     # Find the element with class "appraisal-warning"
#     appraisal_warning = soup.find(class_="appraisal-warning")

#     # Print the result
#     if appraisal_warning:
#         print("Found appraisal-warning content:")
#         print(appraisal_warning)  # Full HTML of the element
#         print("Text content only:")
#         print(appraisal_warning.get_text(strip=True))  # Only the text content
#         appraisal = appraisal_warning.get_text(strip=True)
#     else:
#         print("No element with class 'appraisal-warning' found.")

#       # Find the first occurrence of the element with class "copyable eve-currency-view"
#     first_element = soup.find(class_=["copyable eve-currency-view"])

#     # Check if the element exists
#     if first_element:
#         print("First occurrence of 'copyable eve-currency-view':")
#         print(first_element)  # Full HTML of the element
#         print("Text content only:")
#         print(first_element.get_text(strip=True))  # Only the text content
#         buy_value = first_element.get_text(strip=True)
#     else:
#         print("No element with class 'copyable eve-currency-view' found.")


#      # Find the table body with class "ant-table-tbody"
#     table_body = soup.find("tbody", class_="ant-table-tbody")

#     # Check if the table body exists
#     if table_body:
#         # Find all rows (tr elements) within the table body
#         rows = table_body.find_all("tr")

#         print(f"Number of rows found: {len(rows)}\n")

#         # Iterate over each row and extract its content
#         for index, row in enumerate(rows, start=1):
#             # Extract all cells (td elements) in the current row
#             cells = row.find_all("td")

#             # Get the text content of each cell, stripped of whitespace
#             cell_texts = [cell.get_text(strip=True) for cell in cells]

#             # Print the row index and its cell contents
#             print(f"Row {index}: {cell_texts}")
#     else:
#         print("No table body with class 'ant-table-tbody' found.")

# finally:
#     driver.quit()

def scrape_evaluation_page(url):
    """
    Scrape the appraisal text, buy value, and table rows as a DataFrame from the provided URL.
    
    Args:
        url (str): The URL of the webpage to scrape.

    Returns:
        tuple: A tuple containing:
            - appraisal_text (str): The text in the "appraisal-warning" class.
            - buy_value (str): The text of the first "copyable eve-currency-view" class.
            - table_df (pd.DataFrame): The table data as a pandas DataFrame.
    """
    # Set up Selenium with headless Chrome
    chrome_options = Options()
    chrome_options.add_argument("--headless")  # Run Chrome in headless mode
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--window-size=1920,1080")
    
    # Initialize the WebDriver
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)
    time.sleep(3)
    try:
        # Load the webpage
        driver.get(url)

        # Wait until the page has loaded completely
        wait = WebDriverWait(driver, 15)
        time.sleep(3)
        wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))

        # Extract the rendered page source
        rendered_html = driver.page_source

        # Parse the HTML with BeautifulSoup
        soup = BeautifulSoup(rendered_html, "html.parser")

        # Find the element with class "appraisal-warning"
        appraisal_warning = soup.find(class_="appraisal-warning")
        appraisal_text = appraisal_warning.get_text(strip=True) if appraisal_warning else None

        # Find the first occurrence of the element with class "copyable eve-currency-view"
        first_element = soup.find(class_="copyable eve-currency-view")
        buy_value = first_element.get_text(strip=True) if first_element else None

        # Find the table body with class "ant-table-tbody"
        table_body = soup.find("tbody", class_="ant-table-tbody")
        table_data = []

        # Extract table rows if the table body exists
        if table_body:
            rows = table_body.find_all("tr")
            for row in rows:
                cells = row.find_all("td")
                cell_texts = [cell.get_text(strip=True) for cell in cells]
                table_data.append(cell_texts)
        
        # Convert the table data into a pandas DataFrame
        table_df = pd.DataFrame(table_data)
        
        return appraisal_text, buy_value, table_df
    
    finally:
        driver.quit()
        time.sleep(3)

# # Example usage:
# if __name__ == "__main__":
#     url = "https://janice.e-351.com/a/srbs39"
#     appraisal_text, buy_value, table_df = scrape_evaluation_page(url)
    
#     print("Appraisal Text:", appraisal_text)
#     print("Buy Value:", buy_value)
#     print("\nTable Data:")
#     print(table_df)