/**
 * A service the manager found answering with a web page, opened in the user's browser — the desktop
 * window sends any new-window link there.
 */
import Icon from './Icon.jsx';

/** @param {{web: {url: string, port: number, title: string|null}, name: string}} props */
export default function WebLink({ web, name }) {
  const what = web.title ? `${name} (“${web.title}”)` : name;
  return (
    <a
      className="btn small web-link"
      href={web.url}
      target="_blank"
      rel="noreferrer"
      title={`Open ${what} at ${web.url.replace(/\/$/, '')} in your browser`}
    >
      <Icon name="globe" size={13} />
      Open
    </a>
  );
}
