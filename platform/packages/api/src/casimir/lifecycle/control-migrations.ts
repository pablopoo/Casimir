import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';import {sql} from 'drizzle-orm';import type {DbOrTx} from '../../db/client.ts';
export async function controlMigrationCatalog(version:string){
 const names=version==='c1.0'?['0001_lifecycle.sql']:version==='c1.1'?['0001_lifecycle.sql','0002_upgrade_probe.sql']:null;if(!names)throw new Error('unsupported_control_schema');
 return Promise.all(names.map(async(name,index)=>{const source=await readFile('platform/packages/api/src/casimir/lifecycle/migrations/'+name,'utf8');return {version:index+1,source,hash:createHash('sha256').update(source).digest('hex')};}));
}
export async function assertControlSchema(db:DbOrTx,version:string){const catalog=await controlMigrationCatalog(version),actual=(await db.execute<{version:number;hash:string}>(sql`SELECT version,hash FROM casimir_install.schema_migrations ORDER BY version`)).rows;if(actual.length!==catalog.length||actual.some((row,i)=>row.version!==catalog[i].version||row.hash!==catalog[i].hash))throw new Error('lifecycle_schema_mismatch');return catalog;}
