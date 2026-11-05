import {test} from 'node:test';import assert from 'node:assert/strict';import * as api from '../install.mjs';
test('missing_network_is_distinguished_from_permission_and_transport_failure',()=>{
 assert.equal(typeof api.dockerFailureCode,'function');
 for(const message of ['Error response from daemon: network casimir-test not found','Error response from daemon: get casimir-test: no such volume','Error response from daemon: No such image: sha256:123','Error: No such object: casimir-test'])assert.equal(api.dockerFailureCode(message),'not_found');
 for(const message of ['permission denied','Cannot connect to the Docker daemon','network inspection failed','not found somewhere'])assert.equal(api.dockerFailureCode(message),'docker_failed');
});
