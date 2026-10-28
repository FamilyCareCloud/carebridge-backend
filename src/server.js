import { createApp } from './app.js';
import { Store } from './store.js';
import { createAnalysisService } from './services/bedrock.js';
import { createCarebridgeClient } from './adapters/carebridge.js';
import { createSttService } from './adapters/stt.js';
import { createHttpServer } from './handlers/http.js';
import { AuthService } from './services/auth.js';
if (process.env.NODE_ENV === 'production') throw new Error('운영은 infra/template.yaml의 Cognito/DynamoDB Lambda 구성을 사용하세요.');
const store = new Store(process.env.DATA_FILE ?? './data/fcc-v2.json');
const clock = () => new Date().toISOString();
const auth = new AuthService(store, clock);
const app = createApp(store, { clock, auth, ai: await createAnalysisService(), stt: createSttService(), carebridge: createCarebridgeClient(), workspacePolicy: {
  multipleWorkspaces: process.env.CAREBRIDGE_MULTIPLE_WORKSPACES === 'true',
  transferEnabled: process.env.CAREBRIDGE_TRANSFER_ENABLED === 'true',
  confirmationEnabled: process.env.CAREBRIDGE_CONFIRMATION_ENABLED === 'true',
  recipientChange: process.env.CAREBRIDGE_RECIPIENT_CHANGE,
} });
const port = Number(process.env.PORT ?? 3000);
createHttpServer(app).listen(port, '127.0.0.1', () => console.log(`FCC API: http://127.0.0.1:${port}`));
