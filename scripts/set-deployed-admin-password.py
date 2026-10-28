"""Operator runs this interactively in CloudShell. Never print or accept a password argument."""
import getpass
import os
import boto3

region = os.environ.get('AWS_REGION', 'ap-northeast-2')
table = boto3.resource('dynamodb', region_name=region).Table(os.environ['DYNAMODB_TABLE'])
config = table.get_item(Key={'pk': 'deployment-admin#config'}, ConsistentRead=True)['Item']['data']
client = boto3.client('cognito-idp', region_name=region)
pool = os.environ['COGNITO_USER_POOL_ID']
user = client.admin_get_user(UserPoolId=pool, Username=config['username'])
assert next(a['Value'] for a in user['UserAttributes'] if a['Name'] == 'sub') == config['userId'], 'Identity mismatch'
password = getpass.getpass('New admin password (hidden): ')
confirmation = getpass.getpass('Confirm password (hidden): ')
if password != confirmation:
    raise SystemExit('Passwords do not match. Nothing changed.')
client.admin_set_user_password(UserPoolId=pool, Username=config['username'], Password=password, Permanent=True)
del password, confirmation
print('Password configured. Sign in on the website using admin.')
