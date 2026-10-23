/** Inspect an initialized plain tracker; previewing deletion never dispatches it. */
import { directoryContractAdapter, exploreContracts, reviewContract } from '@unbrained/pm-web';

const adapter = directoryContractAdapter({ pmRoot: '.agents/pm', cwd: process.cwd() });
const page = await exploreContracts(adapter, { limit: 10 });
console.log(JSON.stringify(page));
const detail = await exploreContracts(adapter, { action: 'delete' });
console.log(JSON.stringify(detail.schema));
const preview = await reviewContract(adapter, 'delete', { id: 'demo-1' }, 'edit');
console.log(JSON.stringify(preview)); // executed: false, validated: false
