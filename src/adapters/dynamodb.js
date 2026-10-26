import { fail } from '../domain.js';
// A group aggregate is committed atomically with related membership/profile records.
// Reads are strongly consistent; writes check every read version, including deletions.
export class DynamoStore {
  constructor({ client, tableName, commands }) { this.client = client; this.tableName = tableName; this.commands = commands; }
  async transaction(action, { validateReads = false } = {}) {
    const loaded = new Map(), changes = new Map();
    const get = async key => {
      if (changes.has(key)) return structuredClone(changes.get(key));
      if (!loaded.has(key)) {
        const response = await this.client.send(new this.commands.GetCommand({ TableName: this.tableName, Key: { pk: key }, ConsistentRead: true }));
        loaded.set(key, response.Item ?? null);
      }
      return structuredClone(loaded.get(key)?.data ?? null);
    };
    const result = await action({ get, set: async (key, data) => {
      if (Buffer.byteLength(JSON.stringify(data)) > 350000) fail(413, '데이터 저장 한도를 초과했습니다. 그룹 기록 분할이 필요합니다.', 'RECORD_LIMIT');
      await get(key); changes.set(key, structuredClone(data));
    }, delete: async key => { await get(key); changes.set(key, null); } });
    if (!changes.size && (!validateReads || !loaded.size)) return result;
    if (loaded.size > 100) fail(413, '한 번에 변경하는 데이터가 너무 많습니다.');
    const items = [];
    for (const [key, item] of loaded) {
      const condition = item ? { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': item.version } } : { ConditionExpression: 'attribute_not_exists(pk)' };
      const base = { TableName: this.tableName, ...condition };
      if (!changes.has(key)) items.push({ ConditionCheck: { ...base, Key: { pk: key } } });
      else if (changes.get(key) === null) items.push({ Delete: { ...base, Key: { pk: key } } });
      else {
        const data = changes.get(key);
        items.push({ Put: { ...base, Item: { pk: key, version: (item?.version ?? 0) + 1, data, ...(data.expiresAtEpoch ? { expiresAtEpoch: data.expiresAtEpoch } : {}) } } });
      }
    }
    try { await this.client.send(new this.commands.TransactWriteCommand({ TransactItems: items })); }
    catch (error) {
      if (error.name === 'TransactionCanceledException' || error.name === 'TransactionConflictException') fail(409, '다른 요청이 데이터를 변경했습니다. 다시 조회한 뒤 재시도하세요.', 'CONCURRENT_UPDATE');
      throw error;
    }
    return result;
  }
}
export async function createDynamoStore(env = process.env) {
  if (!env.DYNAMODB_TABLE) throw new Error('DYNAMODB_TABLE is required');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } = await import('@aws-sdk/lib-dynamodb');
  return new DynamoStore({ client: DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.AWS_REGION ?? 'ap-northeast-2' })), tableName: env.DYNAMODB_TABLE, commands: { GetCommand, TransactWriteCommand } });
}
