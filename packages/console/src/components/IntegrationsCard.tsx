import { useState, useEffect } from 'react';
import { TrashIcon, PlusIcon, PencilIcon } from "@heroicons/react/24/outline";
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { client } from '../lib/auth';
import axios from 'axios';

interface FrontSettings {
  authSecret: string;
  emails: string[];
  hasAuthSecret?: boolean;
  apiKeyId?: string;
  apiKeyToken?: string;
}

interface IntegrationsSettings {
  front?: FrontSettings;
}

export default function IntegrationsCard() {
  const { user } = useGraffiticodeAuth();
  const [settings, setSettings] = useState<IntegrationsSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Front integration state
  const [authSecret, setAuthSecret] = useState('');
  const [isEditingSecret, setIsEditingSecret] = useState(false);
  const [apiKeyId, setApiKeyId] = useState('');
  const [apiKeyToken, setApiKeyToken] = useState('');
  const [emails, setEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (user?.uid) {
      fetchSettings();
    }
  }, [user?.uid]);

  const fetchSettings = async () => {
    if (!user?.uid) return;
    try {
      setLoading(true);
      const response = await axios.get('/api/integrations', { headers: { Authorization: await user.getToken() } });
      const data = response.data;
      setSettings(data);
      if (data.front) {
        setAuthSecret(data.front.authSecret || '');
        setApiKeyId(data.front.apiKeyId || '');
        setApiKeyToken(data.front.apiKeyToken || '');
        setEmails(data.front.emails || []);
      }
    } catch (err) {
      console.error('Error fetching integrations:', err);
      setError('Failed to load integration settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      // Include any pending email from the input field
      let emailsToSave = [...emails];
      const pendingEmail = newEmail.trim().toLowerCase();
      if (pendingEmail && !emailsToSave.includes(pendingEmail)) {
        emailsToSave.push(pendingEmail);
        setEmails(emailsToSave);
        setNewEmail('');
      }

      // Create an API key if one doesn't exist or if we're missing the token
      let currentApiKeyId = apiKeyId || settings.front?.apiKeyId;
      let currentApiKeyToken = apiKeyToken;
      if (!currentApiKeyId || !currentApiKeyToken) {
        const userToken = await user.getToken();
        const newApiKey = await client.apiKeys.create(userToken);
        currentApiKeyId = newApiKey.id;
        currentApiKeyToken = newApiKey.token;
        setApiKeyId(currentApiKeyId);
        setApiKeyToken(currentApiKeyToken);
      }

      const frontSettings: FrontSettings = {
        authSecret: authSecret,
        emails: emailsToSave,
        apiKeyId: currentApiKeyId,
        apiKeyToken: currentApiKeyToken,
      };

      await axios.post('/api/integrations', {
        front: frontSettings,
      }, { headers: { Authorization: await user.getToken() } });

      setIsEditingSecret(false);
      await fetchSettings();
    } catch (err) {
      console.error('Error saving integrations:', err);
      setError('Failed to save integration settings');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      // Auto-reset after 3 seconds
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    handleDelete();
  };

  const handleDelete = async () => {
    try {
      setDeleting(true);
      setConfirmDelete(false);
      setError(null);

      // Try to delete the API key if it exists (don't fail if it's already gone)
      if (settings.front?.apiKeyId) {
        try {
          const userToken = await user.getToken();
          await client.apiKeys.remove({ token: userToken, id: settings.front.apiKeyId });
        } catch (apiKeyErr) {
          console.warn('Could not delete API key (may already be deleted):', apiKeyErr);
        }
      }

      // Delete the integration settings
      await axios.delete('/api/integrations', { headers: { Authorization: await user.getToken() } });

      // Reset local state
      setSettings({});
      setAuthSecret('');
      setApiKeyId('');
      setApiKeyToken('');
      setEmails([]);
      setIsEditingSecret(false);
    } catch (err: any) {
      console.error('Error deleting integration:', err);
      console.error('Error details:', err?.response?.data || err?.message || err);
      setError(`Failed to delete integration: ${err?.response?.data?.error || err?.message || 'Unknown error'}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleAddEmail = () => {
    const trimmed = newEmail.trim().toLowerCase();
    if (trimmed) {
      setEmails(prev => prev.includes(trimmed) ? prev : [...prev, trimmed]);
      setNewEmail('');
    }
  };

  const handleRemoveEmail = (email: string) => {
    setEmails(prev => prev.filter(e => e !== email));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddEmail();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="p-4">
        <span className="rounded-none bg-red-100 px-4 py-3 text-base text-red-700" role="alert">
          {error}
        </span>
      </div>
    );
  }

  return (
    <div className="overflow-hidden bg-white p-2">
      {error && (
        <div className="mb-4 rounded-none bg-red-100 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Front Section */}
      <div className="border rounded-none p-4">
        <h3 className="text-lg font-semibold mb-4">Front</h3>

        {/* Auth Secret */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Auth Secret
          </label>
          {!isEditingSecret && settings.front?.hasAuthSecret ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-gray-600 bg-gray-100 px-3 py-2 rounded-none flex-1">
                {authSecret}
              </span>
              <button
                type="button"
                onClick={() => {
                  setAuthSecret('');
                  setIsEditingSecret(true);
                }}
                className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-none text-sm text-gray-700 hover:bg-gray-50"
              >
                <PencilIcon className="h-4 w-4 mr-1" />
                Edit
              </button>
            </div>
          ) : (
            <input
              type="password"
              value={authSecret}
              onChange={(e) => setAuthSecret(e.target.value)}
              placeholder="Enter auth secret"
              className="w-full px-3 py-2 border border-gray-300 rounded-none focus:ring-gray-500 focus:border-gray-500"
            />
          )}
        </div>

        {/* Email Addresses */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Email Addresses
          </label>

          {/* Email List */}
          {emails.length > 0 && (
            <ul className="border border-gray-300 rounded mb-2 divide-y">
              {emails.map((email) => (
                <li key={email} className="flex items-center justify-between px-3 py-2">
                  <span className="font-mono text-sm">{email}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveEmail(email)}
                    className="text-red-500 hover:text-red-700"
                  >
                    <TrashIcon className="h-5 w-5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add Email Input */}
          <div className="flex gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="user@example.com"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-none focus:ring-gray-500 focus:border-gray-500"
            />
            <button
              type="button"
              onClick={handleAddEmail}
              disabled={!newEmail.trim()}
              className="inline-flex items-center px-3 py-2 bg-gray-100 border border-gray-300 rounded-none text-sm text-gray-700 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <PlusIcon className="h-4 w-4 mr-1" />
              Add
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-between">
          {settings.front?.apiKeyId ? (
            <button
              type="button"
              onClick={handleDeleteClick}
              disabled={deleting || saving}
              className={`inline-flex items-center px-4 py-2 text-white rounded-none disabled:opacity-50 disabled:cursor-not-allowed ${
                confirmDelete ? 'bg-red-700 hover:bg-red-800' : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {deleting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Deleting...
                </>
              ) : confirmDelete ? (
                'Click again to confirm'
              ) : (
                <>
                  <TrashIcon className="h-4 w-4 mr-1" />
                  Delete Integration
                </>
              )}
            </button>
          ) : (
            <div></div>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || deleting}
            className="inline-flex items-center px-4 py-2 bg-primary text-white rounded-none hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
