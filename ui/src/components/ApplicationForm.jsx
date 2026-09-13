/**
 * Create or rename an application. An application carries no runtime settings of its own — it is
 * the group its processes are started and stopped as — so there is nothing here but identity.
 */
import { useState } from 'react';
import Modal from './Modal.jsx';
import Field, { nameError } from './Field.jsx';

/**
 * @param {{application: object|null, onSubmit: (values: object) => Promise<void>,
 *          onClose: () => void}} props
 */
export default function ApplicationForm({ application, onSubmit, onClose }) {
  const [name, setName] = useState(application?.name ?? '');
  const [description, setDescription] = useState(application?.description ?? '');
  const [error, setError] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const invalid = nameError(name);
    setError(invalid);
    if (invalid) return;

    setServerError(null);
    setSaving(true);
    try {
      await onSubmit({ name: name.trim(), description: description.trim() });
    } catch (err) {
      setServerError(err.message); // the manager is authoritative; show exactly what it said
      setSaving(false);
    }
  };

  return (
    <Modal title={application ? 'Edit application' : 'New application'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Name" value={name} onChange={setName} error={error} />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
          rows={2}
          hint="Optional. What this application is, for whoever opens the dashboard next."
          spellCheck
        />
        {serverError && (
          <p className="form-error" role="alert">
            {serverError}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
