import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp, mkdtemp, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageExtension} from '../scripts/package.mjs';

test('the shipped ZIP is reproducible, complete and readable by an independent ZIP reader', async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const archive=join(root,'releases/supermux-browser-extension.zip');
  let first;
  for(let pass=0;pass<2;pass++) {
    const result=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const bytes=await readFile(archive);
    if(pass===0) first=bytes;
    else assert.deepEqual(bytes,first);
  }
  const inspect=spawnSync('python3',['-c',`
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    assert len(z.namelist()) == 13
    assert 'manifest.json' in z.namelist()
    assert json.loads(z.read('manifest.json'))['manifest_version'] == 3
    assert '__CONTENT_CSS__' not in z.read('content.js').decode()
    assert '__SAFE_URL__' not in z.read('content.js').decode()
    assert '__BRAND_SVG__' not in z.read('content.js').decode()
    assert 'M 264.233,306.112' in z.read('logo.svg').decode()
    assert 'M 264.233,306.112' in z.read('content.js').decode()
    for size in (16,32,48,128):
        image=z.read(f'icons/{size}.png')
        assert image[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
        assert int.from_bytes(image[16:20],'big') == size
        assert int.from_bytes(image[20:24],'big') == size
    assert all(i.date_time == (1980,1,1,0,0,0) for i in z.infolist())
`,archive],{encoding:'utf8'});
  assert.equal(inspect.status,0,inspect.stderr);
});

test('packaging ignores file timestamps and refuses unexpected local data', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'supermux-extension-package-'));
  try {
    const dist=join(dir,'dist');
    await cp(fileURLToPath(new URL('../src/',import.meta.url)),dist,{recursive:true});

    const archive=new URL(`file://${join(dir,'extension.zip')}`);
    const first=await packageExtension(dist,archive);
    await utimes(join(dist,'content.js'),new Date(0),new Date(0));
    assert.deepEqual(await packageExtension(dist,archive),first);
    await writeFile(join(dist,'private-settings.json'),'secret-test-fixture');
    await assert.rejects(packageExtension(dist,archive),/Unexpected extension asset/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
