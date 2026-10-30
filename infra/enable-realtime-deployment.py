"""Prepare scoped deployment permissions; run in authorized CloudShell with --apply to install.

No credentials or IAM changes are made by the application or CI itself.
"""
import argparse
import json
import boto3

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
region, account, stack = 'ap-northeast-2', '055047416353', 'fcc-backend-dev'
if boto3.client('sts').get_caller_identity()['Account'] != account:
    raise SystemExit('Unexpected AWS account; no changes made')
resources = boto3.client('cloudformation', region_name=region).describe_stack_resources(StackName=stack)['StackResources']
table = next(r['PhysicalResourceId'] for r in resources if r['LogicalResourceId'] == 'Database')
policy = {'Version': '2012-10-17', 'Statement': [
    {'Sid': 'EnableExistingTableStream', 'Effect': 'Allow',
     'Action': ['dynamodb:DescribeTable', 'dynamodb:UpdateTable', 'dynamodb:ListTagsOfResource'],
     'Resource': f'arn:aws:dynamodb:{region}:{account}:table/{table}'},
    {'Sid': 'ManageRealtimeFunction', 'Effect': 'Allow',
     'Action': ['lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration', 'lambda:GetPolicy', 'lambda:AddPermission', 'lambda:RemovePermission', 'lambda:TagResource', 'lambda:UntagResource', 'lambda:ListTags'],
     'Resource': f'arn:aws:lambda:{region}:{account}:function:{stack}-Realtime-*'},
    {'Sid': 'ManageStreamMapping', 'Effect': 'Allow',
     'Action': ['lambda:CreateEventSourceMapping', 'lambda:GetEventSourceMapping', 'lambda:UpdateEventSourceMapping', 'lambda:DeleteEventSourceMapping', 'lambda:ListEventSourceMappings', 'lambda:TagResource', 'lambda:UntagResource', 'lambda:ListTags'],
     'Resource': '*'},
    {'Sid': 'ManageRealtimeRuntimeRole', 'Effect': 'Allow',
     'Action': ['iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole', 'iam:TagRole', 'iam:UntagRole', 'iam:PutRolePolicy', 'iam:GetRolePolicy', 'iam:DeleteRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
     'Resource': f'arn:aws:iam::{account}:role/{stack}-RealtimeRole-*'},
    {'Sid': 'PassRealtimeRuntimeRole', 'Effect': 'Allow', 'Action': 'iam:PassRole',
     'Resource': f'arn:aws:iam::{account}:role/{stack}-RealtimeRole-*',
     'Condition': {'StringEquals': {'iam:PassedToService': 'lambda.amazonaws.com'}}},
    {'Sid': 'CreateWebsocketApiAndRoutes', 'Effect': 'Allow',
     'Action': ['apigateway:GET', 'apigateway:POST', 'apigateway:PATCH', 'apigateway:DELETE', 'apigateway:PUT'],
     'Resource': [f'arn:aws:apigateway:{region}::/apis', f'arn:aws:apigateway:{region}::/apis/*', f'arn:aws:apigateway:{region}::/tags/*']},
    {'Sid': 'ManageRealtimeSweepRule', 'Effect': 'Allow',
     'Action': ['events:PutRule', 'events:DeleteRule', 'events:DescribeRule', 'events:PutTargets', 'events:RemoveTargets', 'events:ListTargetsByRule', 'events:TagResource', 'events:UntagResource', 'events:ListTagsForResource'],
     'Resource': f'arn:aws:events:{region}:{account}:rule/{stack}-Realtime*'},
    {'Sid': 'ManageRealtimeLogs', 'Effect': 'Allow',
     'Action': ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy', 'logs:TagResource', 'logs:UntagResource', 'logs:ListTagsForResource'],
     'Resource': f'arn:aws:logs:{region}:{account}:log-group:/aws/lambda/{stack}-Realtime-*'},
    {'Sid': 'ReadLogGroupMetadata', 'Effect': 'Allow', 'Action': 'logs:DescribeLogGroups', 'Resource': '*'},
]}
if args.apply:
    boto3.client('iam').put_role_policy(RoleName='fcc-backend-github-deploy', PolicyName='FccRealtimeDeployment', PolicyDocument=json.dumps(policy))
    print('Realtime deployment permissions installed. Re-run the develop deployment.')
else:
    print(json.dumps(policy, indent=2))
