import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { copyPackagedRuntime, verifyPackagedRuntime } from "./packaged-runtime.mjs";
import afterPack from "./after-pack.mjs";
const sha = (text) => createHash("sha256").update(text).digest("hex");
function fixture() {
 const root=mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(),"packaged-runtime-"));
 const stage=join(root,"stage"), output=join(root,"application"), destination=join(output,"resources/codex-automation");
 const files=[{path:"codex_oauth.py",sha256:sha("helper")},{path:"node_modules/browser-bridge/index.js",sha256:sha("bridge")},{path:".python-runtime/python.exe",sha256:sha("python")}];
 for(const [name,text] of [[files[0].path,"helper"],[files[1].path,"bridge"],[files[2].path,"python"]]){const p=join(stage,name);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text)}
 const manifest={schemaVersion:1,files,sha256:sha(JSON.stringify(files))};writeFileSync(join(stage,"runtime-integrity.json"),JSON.stringify(manifest));
 return {root,stage,output,destination,manifest};
}
test("afterPack restores nested node_modules filtered by extraResources and verifies hashes",async()=>{
 const f=fixture();try{mkdirSync(f.destination,{recursive:true});writeFileSync(join(f.destination,"codex_oauth.py"),"helper");
 await afterPack({appOutDir:f.output,packager:{config:{extraResources:[{from:f.stage,to:"codex-automation"}]}}});
 assert.equal(verifyPackagedRuntime(f.destination),3);assert.equal(readFileSync(join(f.destination,"node_modules/browser-bridge/index.js"),"utf8"),"bridge");
 writeFileSync(join(f.destination,"node_modules/browser-bridge/index.js"),"corrupt");assert.throws(()=>verifyPackagedRuntime(f.destination),/hash mismatch/);
 }finally{rmSync(f.root,{recursive:true,force:true})}
});
test("copy refuses tampered source and unsafe inventory paths",()=>{
 const f=fixture();try{writeFileSync(join(f.stage,"codex_oauth.py"),"changed");assert.throws(()=>copyPackagedRuntime(f.stage,f.destination),/Staged automation hash mismatch/);
 f.manifest.files[0].path="../private.txt";f.manifest.sha256=sha(JSON.stringify(f.manifest.files));writeFileSync(join(f.stage,"runtime-integrity.json"),JSON.stringify(f.manifest));assert.throws(()=>copyPackagedRuntime(f.stage,f.destination),/Unsafe automation/);
 }finally{rmSync(f.root,{recursive:true,force:true})}
});
test("hook fails closed when staging is not configured",async()=>{await assert.rejects(()=>afterPack({appOutDir:"unused",packager:{config:{extraResources:[]}}}),/staging is missing/)});
