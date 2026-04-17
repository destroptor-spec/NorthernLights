import { clearAndRedownloadModels } from './server/services/downloadModels'; clearAndRedownloadModels().then(() => console.log('Done')).catch(console.error);
