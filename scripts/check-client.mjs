import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script,'Browser script exists');
new Function(script);
for(const subset of ['latin','cyrillic','cyrillic-ext']) {
  const font=readFileSync(new URL('../node_modules/@fontsource-variable/golos-text/files/golos-text-'+subset+'-wght-normal.woff2',import.meta.url));
  assert.equal(font.subarray(0,4).toString(),'wOF2','Bundled WOFF2 font '+subset);
}
console.log('RITM_CLIENT_SYNTAX_AND_FONTS_PASS');
