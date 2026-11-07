// Validate manifest.yml against the official @forge/manifest JSON schema (no login needed).
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load as loadYaml } from 'js-yaml';

// The package does not export its schema path, so read it from node_modules directly.
const schemaUrl = new URL('../node_modules/@forge/manifest/out/schema/manifest-schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8'));
const manifest = loadYaml(readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
if (validate(manifest)) {
  console.log('manifest.yml: valid');
} else {
  console.error(JSON.stringify(validate.errors.slice(0, 20), null, 2));
  process.exit(1);
}
