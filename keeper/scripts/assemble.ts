/** Turns a signed result from the Levee contract into raw transaction hex. Reads a JSON file. */
import { readFileSync } from 'node:fs';
import { assembleSignedTransaction } from '../src/signature.ts';

const result = JSON.parse(readFileSync(process.argv[2] as string, 'utf8'));
const assembled = await assembleSignedTransaction(result);
console.log(assembled.serialized);
console.error(`signer ${assembled.signer} hash ${assembled.hash}`);
