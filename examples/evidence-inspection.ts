/** Read exactly the item panel facts, with explicit project selection and bounded output. */
import { EvidenceInspectionClient, EvidenceInspectionError } from '@unbrained/pm-web';

const token = process.env.PM_WEB_TOKEN;
if (!token) throw new Error('Set PM_WEB_TOKEN with the operator secret mechanism.');
const client = new EvidenceInspectionClient('https://pm.example.test', token);
try {
  const page = await client.inspect('12345678-1234-1234-1234-123456789abc', { item: 'example-task', limit: 5, budget: 2400 });
  console.log(JSON.stringify({ facts: page.rows, omitted: page.omitted, nextOffset: page.nextOffset, truthAssessed: page.truthAssessed }));
} catch (error) {
  if (error instanceof EvidenceInspectionError) console.error(`${error.code}: ${error.remedy}`);
  else throw error;
}
