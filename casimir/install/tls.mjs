import {X509Certificate,createPrivateKey} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
export async function validateCertificates(config){
 for(const path of Object.values(config.certificatePaths)){const s=await lstat(path);if(!s.isFile()||await realpath(path)!==path||s.size>1024*1024)throw new Error('certificate_regular_file_required');}
 const caOnly=new X509Certificate(await readFile(config.certificatePaths.ca));
 if(!caOnly.ca||Date.parse(caOnly.validFrom)>Date.now()||Date.parse(caOnly.validTo)<=Date.now())throw new Error('certificate_ca_invalid_or_expired');
 if(config.mode==='external-tls')return;
 const cert=new X509Certificate(await readFile(config.certificatePaths.certificate)),ca=new X509Certificate(await readFile(config.certificatePaths.ca));
 if(Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now()||!cert.verify(ca.publicKey)||!cert.checkPrivateKey(createPrivateKey(await readFile(config.certificatePaths.key))))throw new Error('certificate_expired_untrusted_or_wrong_key');
 for(const origin of [config.controlOrigin,config.appOrigin]){const host=new URL(origin).hostname;if(!cert.checkHost(host)&&!cert.checkIP(host))throw new Error('certificate_hostname_mismatch');}
}
export function tlsConfig(config,scope){
 if(!/^casimir-[a-f0-9]{32}$/.test(scope))throw new Error('tls_scope');
 const servers=[['control',8080],['app',8081]].map(([role,port])=>{const u=new URL(config[role+'Origin']);if(u.protocol!=='https:'||!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(u.host))throw new Error('tls_origin');return `server { listen ${port} ssl; server_name ${u.hostname}; ssl_certificate /certs/cert.pem; ssl_certificate_key /certs/key.pem; if ($http_host != "${u.host}") { return 403; } location / { proxy_pass http://${scope}-${role}-ingress:8080; proxy_set_header Host "${u.host}"; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-Host "${u.host}"; proxy_request_buffering off; proxy_buffering off; proxy_read_timeout 60s; } }`;}).join('\n');
 return `pid /tmp/nginx.pid; error_log /dev/stderr warn; events {} http { access_log off; client_max_body_size 65m; client_body_temp_path /tmp/body; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; ${servers} }`;
}
