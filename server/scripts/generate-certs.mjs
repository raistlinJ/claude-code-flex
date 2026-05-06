import fs from 'fs/promises';
import path from 'path';
import selfsigned from 'selfsigned';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDir = path.resolve(__dirname, '..');

const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, {
  algorithm: 'sha256',
  days: 365,
  keySize: 4096,
  extensions: [
    {
      name: 'basicConstraints',
      cA: false
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true
    },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' }
      ]
    }
  ]
});

await fs.writeFile(path.join(serverDir, 'key.pem'), pems.private, 'utf8');
await fs.writeFile(path.join(serverDir, 'cert.pem'), pems.cert, 'utf8');

console.log('Generated self-signed SSL certificates:');
console.log(`- ${path.join(serverDir, 'key.pem')}`);
console.log(`- ${path.join(serverDir, 'cert.pem')}`);
