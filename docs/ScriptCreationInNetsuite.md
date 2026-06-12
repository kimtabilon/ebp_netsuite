NetSuite Script Deployment Guide
Follow these steps to upload and deploy a new script (like a RESTlet) in NetSuite.

Step 1: Upload the File to the File Cabinet
Log in to NetSuite as an Administrator.
Navigate to Documents > Files > File Cabinet.
Find the folder where you store your scripts (usually SuiteScripts).
Click Add File and upload the .js file from your computer.


Step 2: Create the Script Record
Navigate to Customization > Scripting > Scripts > New.
In the Script File field, select the file you just uploaded.
Click Create Script Record.
On the Script Record page:
Name: Give it a descriptive name (e.g., EBP Item Fulfillment Sync).
ID: Give it a unique ID (e.g., _ebp_if_sync). NetSuite will prefix this with customscript.
Type: This should automatically be detected as RESTlet (or whatever type your script is).
Click Save.


Step 3: Create the Script Deployment
On the Script Record you just saved, click the Deployments tab.
Click New Deployment.
On the Script Deployment page:
Title: Usually the same as the script name.
ID: Give it a unique ID (e.g., _ebp_if_sync_d1). NetSuite will prefix this with customdeploy.
Status: Set to Released (or Testing if you only want it to run for you).
Audience: Select the Roles, Employees, or Subsidiaries that are allowed to call this script. For API integrations, usually, you select the specific integration role.
Click Save.


Step 4: Get the External URL (For RESTlets)
Once the Deployment is saved, you will see an External URL and a RESTlet URL field.
External URL: Copy this URL. It will look like https://<ACCOUNT_ID>.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=...&deploy=....
You will need the script and deploy numbers from this URL for your .env file in the code.