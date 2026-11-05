import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { adoptCasimirManagementOwner, bootstrapInstallationDatabase, createDb, readCasimirManagementOwner } from '../dist/checks.mjs';
const {Pool}=createRequire(new URL('../../platform/packages/api/package.json',import.meta.url))('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:3000});
try {
 const installationId=process.env.CASIMIR_INSTALLATION_ID,bundleVersion=process.env.CASIMIR_BUNDLE_VERSION,resultPath=process.env.CASIMIR_BOOTSTRAP_RESULT;
 if(!installationId||!bundleVersion||!resultPath)throw new Error('installation_database_bootstrap_configuration');
 const db=createDb(pool),mode=process.env.CASIMIR_MANAGEMENT_ENROLLMENT;
 let ids;
 if(mode==='true'){
  const owner=await readCasimirManagementOwner('/state');
  const config=await adoptCasimirManagementOwner(db,owner,bundleVersion,'/state');
  if(config.installationId!==installationId)throw new Error('management_enrollment_identity');
  ids={operatorId:config.operatorId,projectId:config.projectId};
 }else if(mode===undefined){
  ids=await bootstrapInstallationDatabase(db,installationId,bundleVersion);
 }else throw new Error('management_enrollment_mode');
 await writeFile(resultPath,JSON.stringify(ids),{mode:0o600});
}
catch {console.error('installation_database_bootstrap_failed');process.exitCode=1;}
finally {await pool.end();}
