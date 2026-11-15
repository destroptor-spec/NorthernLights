// Imported first by server/index.ts: from here on the console is also
// recorded in Aurora's rotating log files (services/logger.ts).
import { installLogging } from './services/logger';

installLogging();
