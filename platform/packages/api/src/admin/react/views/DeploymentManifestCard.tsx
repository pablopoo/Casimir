/** @jsxImportSource react */

import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Table, TableBody, TableCell, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import type { CasimirManifest } from '@void/deploy-core';
import type { DeployManifest } from '../../../types.ts';
import { AdminCard } from './AdminCard.tsx';
import { CodeBlock } from './CodeBlock.tsx';

type DeploymentManifest = DeployManifest | CasimirManifest;

function isCasimirManifest(manifest: DeploymentManifest): manifest is CasimirManifest {
  return 'protocol' in manifest;
}

function casimirMigrations(manifest: CasimirManifest): string {
  return manifest.migrations.length
    ? `${manifest.migrations.length} included: ${manifest.migrations.map((migration) => migration.name).join(', ')}`
    : 'None included';
}

export function DeploymentManifestCard({ manifest }: { manifest: DeploymentManifest }) {
  return (
    <AdminCard title="Manifest">
      <Table>
        <TableBody>
          {isCasimirManifest(manifest) ? (
            <>
              <TableRow>
                <TableHeaderCell>Runtime protocol</TableHeaderCell>
                <TableCell>{manifest.protocol}</TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Runtime profile</TableHeaderCell>
                <TableCell>{manifest.profile}</TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>SDK version</TableHeaderCell>
                <TableCell>{manifest.sdkVersion}</TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Runtime ID</TableHeaderCell>
                <TableCell>
                  <code>{manifest.runtimeId}</code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Platform</TableHeaderCell>
                <TableCell>{manifest.platform}</TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Node ABI</TableHeaderCell>
                <TableCell>{manifest.nodeAbi}</TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Entry</TableHeaderCell>
                <TableCell>
                  <code>{manifest.entry}</code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Migrations included</TableHeaderCell>
                <TableCell>{casimirMigrations(manifest)}</TableCell>
              </TableRow>
            </>
          ) : (
            <>
              {manifest.bindings &&
                Object.entries(manifest.bindings).map(([type, value]) =>
                  Array.isArray(value) && value.length > 0 ? (
                    <TableRow key={type}>
                      <TableHeaderCell>{type.toUpperCase()}</TableHeaderCell>
                      <TableCell>
                        {value.map((name: string, index: number) => (
                          <span key={name}>
                            {index > 0 && ', '}
                            <code>{name}</code>
                          </span>
                        ))}
                      </TableCell>
                    </TableRow>
                  ) : value === true ? (
                    <TableRow key={type}>
                      <TableHeaderCell>{type.toUpperCase()}</TableHeaderCell>
                      <TableCell>enabled</TableCell>
                    </TableRow>
                  ) : null,
                )}
              {manifest.migrations && (
                <TableRow>
                  <TableHeaderCell>Migrations</TableHeaderCell>
                  <TableCell>
                    {manifest.migrations.dialect} — {manifest.migrations.pending} pending
                  </TableCell>
                </TableRow>
              )}
              {manifest.schedules && manifest.schedules.length > 0 && (
                <TableRow>
                  <TableHeaderCell>Schedules</TableHeaderCell>
                  <TableCell>
                    {manifest.schedules.map((schedule, index) => (
                      <span key={schedule.name}>
                        {index > 0 && ', '}
                        {schedule.name}: {schedule.cron}
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              )}
            </>
          )}
        </TableBody>
      </Table>
      <Collapsible
        className="void-admin-disclosure"
        trigger="Raw JSON"
        chevronPosition="start"
        defaultIsOpen={false}
      >
        <CodeBlock code={JSON.stringify(manifest, null, 2)} language="json" />
      </Collapsible>
    </AdminCard>
  );
}
