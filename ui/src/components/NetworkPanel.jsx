/**
 * The machine's network, on the ports page: its private and public address, then every interface
 * with its addresses. It sits with the ports because that is where the question comes up — which
 * address the phone on the desk should open, and what a port reachable off-machine is reachable at.
 *
 * Rendering only: the reading comes from the shell's live state, and the page's Refresh refreshes it.
 */
import CopyButton from './CopyButton.jsx';
import Icon from './Icon.jsx';
import { describePrivateIp, describePublicIp } from '../format.js';

/**
 * A value with where it came from beside it, and a copy button when there is something to copy.
 * Exported for the dashboard's network summary.
 * @param {{label: string, described: {address: string|null, value: string, note: string}}} props
 */
export function AddressFact({ label, described }) {
  const { address, value, note } = described;
  return (
    <div className="fact address-fact">
      <dt>{label}</dt>
      <dd>
        <code>{value}</code>
        <span className="fact-note">{note}</span>
        {address && <CopyButton text={address} label={`Copy the ${label}`} />}
      </dd>
    </div>
  );
}

/** @param {{interfaces: object[]}} props */
function InterfacesTable({ interfaces }) {
  if (!interfaces.length) return <p className="empty-inline">No network interface is up.</p>;
  return (
    <div className="table-scroll">
      <table className="network-table">
        <thead>
          <tr>
            <th scope="col">Interface</th>
            <th scope="col">Addresses</th>
            <th scope="col">MAC</th>
          </tr>
        </thead>
        <tbody>
          {interfaces.map((entry) => (
            <tr key={entry.name}>
              <td>
                <span className="mono">{entry.name}</span>
                {entry.primary && <span className="tag">default route</span>}
              </td>
              <td>
                <span className="interface-addresses">
                  {entry.addresses.map(({ family, address, cidr }) => (
                    <code key={address} title={family}>{cidr ?? address}</code>
                  ))}
                </span>
              </td>
              <td className="mono">{entry.mac ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** @param {{network: object|null}} props null until the first reading lands */
export default function NetworkPanel({ network }) {
  return (
    <section className="panel network" aria-label="Network">
      <div className="panel-head">
        <h2 className="panel-title">
          <Icon name="network" />
          Network
        </h2>
        <span className="spacer" />
        {network && <span className="meta">{network.hostname}</span>}
      </div>
      <dl className="group-facts network-facts">
        <AddressFact label="Private IP" described={describePrivateIp(network)} />
        <AddressFact label="Public IP" described={describePublicIp(network)} />
      </dl>
      {network ? <InterfacesTable interfaces={network.interfaces} /> : <p className="empty-inline">Reading…</p>}
    </section>
  );
}
