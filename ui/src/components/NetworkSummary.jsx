/**
 * The machine's addresses at the foot of the sidebar, under its load: the private one a phone on the
 * same Wi-Fi opens a dev server at, and the public one the internet sees. Either is one click to
 * copy; every interface is on the Local ports page.
 */
import CopyButton from './CopyButton.jsx';
import Icon from './Icon.jsx';
import { describePrivateIp, describePublicIp } from '../format.js';

/**
 * The address is in the tooltip as well as the row, because at the rail's narrowest a public
 * address can be cut short.
 * @param {{icon: string, label: string,
 *          described: {address: string|null, value: string, note: string}}} props
 */
function AddressRow({ icon, label, described }) {
  const { address, value, note } = described;
  return (
    <div className="address-row" title={address ? `${address} · ${note}` : note}>
      <Icon name={icon} />
      <span className="address-label">{label}</span>
      <span className="address-value">{value}</span>
      {address && <CopyButton text={address} label={`Copy the ${label.toLowerCase()} IP`} />}
    </div>
  );
}

/**
 * @param {{network: object|null, stale: boolean}} props `stale` while the stream is down, so an
 *   address from before a network switch is not mistaken for the current one
 */
export default function NetworkSummary({ network, stale }) {
  return (
    <div className={`network-summary${stale ? ' stale' : ''}`} role="group" aria-label="Network">
      <p className="sidebar-label">Network</p>
      <AddressRow icon="network" label="Private" described={describePrivateIp(network)} />
      <AddressRow icon="globe" label="Public" described={describePublicIp(network)} />
    </div>
  );
}
