import {test} from 'node:test';import assert from 'node:assert/strict';import * as checks from '../../dist/checks.mjs';
test('requested_host_bindings_without_actual_published_ports_are_not_ready',async()=>{
 assert.equal(typeof checks.inspectIngressPublication,'function');
 const engine={scope:'casimir-'+'1'.repeat(32),async inspectContainer(){return {State:{Running:true},HostConfig:{PortBindings:{'8080/tcp':[{HostPort:'4485'}]}},NetworkSettings:{Ports:{'8080/tcp':null},Networks:{}}};}};
 await assert.rejects(()=>checks.inspectIngressPublication(engine,{control:'https://control.c1.test:4485',app:'https://app.c1.test:4486'},Buffer.from('fixture')),/ingress_listener_unpublished/);
});
test('external_tls_rejects_publicly_bound_backend_even_when_port_matches',async()=>{
 const scope='casimir-'+'2'.repeat(32),engine={scope,async inspectContainer(){return {State:{Running:true},NetworkSettings:{Ports:{'8080/tcp':[{HostIp:'0.0.0.0',HostPort:'4495'}]},Networks:{}}};}};
 await assert.rejects(()=>checks.inspectIngressPublication(engine,{control:'https://control.external.test:4485',app:'https://app.external.test:4486'},Buffer.from('fixture'),{controlPort:4495,appPort:4496}),/external_tls_backend_not_loopback/);
});
