import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { mutate } from 'swr';
import { UserCircleIcon, CameraIcon } from '@heroicons/react/24/outline';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { getTitle, getPageTitle } from '../lib/utils';
import SignIn from '../components/SignIn';

interface UserData {
  uid?: string;
  name?: string;
  email?: string;
  phone?: string;
  created?: string;
  updated?: string;
  stripeCreated?: string;
  stripeCustomerId?: string;
  profileImageUrl?: string;
  notificationEmail?: string;
  notificationPhone?: string;
  notifyByEmail?: boolean;
  notifyByPhone?: boolean;
  signInEmail?: string;
  signInEmailVerifiedAt?: string;
}

export default function Profile() {
  const { user, loading } = useGraffiticodeAuth();
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [notificationEmail, setNotificationEmail] = useState('');
  const [notificationPhone, setNotificationPhone] = useState('');
  const [notifyByEmail, setNotifyByEmail] = useState(false);
  const [notifyByPhone, setNotifyByPhone] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user && !loading) {
      fetchUserData();
    }
  }, [user, loading]);

  useEffect(() => {
    if (userData) {
      setImagePreview(userData.profileImageUrl || null);
      setDisplayName(userData.name || user?.displayName || '');
      setNotificationEmail(userData.notificationEmail || '');
      setNotificationPhone(userData.notificationPhone || '');
      // Only enable if there's data in the field AND the preference is set
      setNotifyByEmail(userData.notificationEmail ? (userData.notifyByEmail ?? false) : false);
      setNotifyByPhone(userData.notificationPhone ? (userData.notifyByPhone ?? false) : false);
    }
  }, [userData]);

  const fetchUserData = async () => {
    try {
      setLoadingData(true);
      const token = await user.getToken();
      const response = await fetch(`/api/user/${user.uid}`, {
        headers: {
          'Authorization': token,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setUserData(data);
      } else if (response.status === 404) {
        // User exists in Firebase Auth but not in Firestore yet
        setUserData({ uid: user.uid });
      } else {
        throw new Error('Failed to fetch user data');
      }
    } catch (err) {
      console.error('Error fetching user data:', err);
      setError('Failed to load profile information');
    } finally {
      setLoadingData(false);
    }
  };

  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      alert('Image must be less than 5MB');
      return;
    }

    // Create preview and save
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64Image = reader.result as string;
      setImagePreview(base64Image);

      // Save to server
      try {
        const token = await user.getToken();
        const response = await fetch(`/api/user/${user.uid}`, {
          method: 'PUT',
          headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profileImageUrl: base64Image,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to save profile image');
        }
        // Update the SignIn component's cached user data
        mutate(`user-profile-${user.uid}`);
      } catch (err) {
        console.error('Error saving profile image:', err);
        alert('Failed to save profile image');
      }
    };
    reader.readAsDataURL(file);
  };

  const formatPhoneNumber = (value: string, prevValue: string): string => {
    // Remove all non-digit characters
    let digits = value.replace(/\D/g, '');

    // Handle empty input
    if (digits.length === 0) return '';

    // If user is deleting (value shorter than previous), don't auto-insert 1
    const isDeleting = value.length < prevValue.length;

    // If just "1", return as-is (allow deleting back to +1)
    if (digits === '1') {
      return '+1';
    }

    // If starts with 1, use it as country code
    // Otherwise, prepend 1 (but only if not deleting to empty)
    if (digits[0] !== '1' && !isDeleting) {
      digits = '1' + digits;
    } else if (digits[0] !== '1' && isDeleting) {
      // User is deleting and no country code - just format what's there
      if (digits.length <= 3) {
        return `+1 (${digits}`;
      } else if (digits.length <= 6) {
        return `+1 (${digits.slice(0, 3)}) ${digits.slice(3)}`;
      } else {
        return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
      }
    }

    // Format as +1 (XXX) XXX-XXXX
    if (digits.length <= 1) {
      return `+${digits}`;
    } else if (digits.length <= 4) {
      return `+${digits[0]} (${digits.slice(1)}`;
    } else if (digits.length <= 7) {
      return `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4)}`;
    } else {
      return `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 11)}`;
    }
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatPhoneNumber(e.target.value, notificationPhone);
    setNotificationPhone(formatted);
  };

  const saveDisplayName = async (name: string) => {
    try {
      const token = await user.getToken();
      const response = await fetch(`/api/user/${user.uid}`, {
        method: 'PUT',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: name,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save name');
      }
      // Update the SignIn component's cached user data
      mutate(`user-profile-${user.uid}`);
    } catch (err) {
      console.error('Error saving name:', err);
    }
  };

  const saveNotificationEmail = async (email: string) => {
    // If email is cleared, also disable notifications
    const shouldDisable = !email.trim();
    if (shouldDisable) {
      setNotifyByEmail(false);
    }

    try {
      const token = await user.getToken();
      const response = await fetch(`/api/user/${user.uid}`, {
        method: 'PUT',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          notificationEmail: email,
          ...(shouldDisable && { notifyByEmail: false }),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save notification email');
      }
    } catch (err) {
      console.error('Error saving notification email:', err);
    }
  };

  const saveNotificationPhone = async (phone: string) => {
    // If phone is cleared, also disable notifications
    const shouldDisable = !phone.trim();
    if (shouldDisable) {
      setNotifyByPhone(false);
    }

    try {
      const token = await user.getToken();
      const response = await fetch(`/api/user/${user.uid}`, {
        method: 'PUT',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          notificationPhone: phone,
          ...(shouldDisable && { notifyByPhone: false }),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save notification phone');
      }
    } catch (err) {
      console.error('Error saving notification phone:', err);
    }
  };

  const saveNotifyPreference = async (byEmail: boolean, byPhone: boolean) => {
    try {
      const token = await user.getToken();
      const response = await fetch(`/api/user/${user.uid}`, {
        method: 'PUT',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          notifyByEmail: byEmail,
          notifyByPhone: byPhone,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save notification preference');
      }
    } catch (err) {
      console.error('Error saving notification preference:', err);
    }
  };

  const handleNotifyByEmailChange = (checked: boolean) => {
    setNotifyByEmail(checked);
    saveNotifyPreference(checked, notifyByPhone);
  };

  const handleNotifyByPhoneChange = (checked: boolean) => {
    setNotifyByPhone(checked);
    saveNotifyPreference(notifyByEmail, checked);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)]">
        <SignIn label="Sign in to continue" />
        <p className="mt-4 text-sm text-gray-600 text-center max-w-sm">
          New here? Create a free account by signing in with an Ethereum wallet. No blockchain fees required.
        </p>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>{getPageTitle('Profile')}</title>
      </Head>

      <div className="min-h-screen bg-gray-50">
        <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Profile</h1>
            <p className="mt-2 text-sm text-gray-600">
              Your personal information and account details.
            </p>
          </div>

          {loadingData ? (
            <div className="bg-white shadow rounded-none p-6">
              <div className="animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
                <div className="h-4 bg-gray-200 rounded w-1/2 mb-4"></div>
                <div className="h-4 bg-gray-200 rounded w-2/3"></div>
              </div>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-none p-6">
              <p className="text-red-800">{error}</p>
            </div>
          ) : (
            <>
            <div className="bg-white shadow rounded-none overflow-hidden">
              <div className="px-6 py-5 border-b border-gray-200 bg-gray-50">
                <div className="flex items-center">
                  <div className="relative">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleImageChange}
                      accept="image/*"
                      className="hidden"
                    />
                    <button
                      onClick={handleImageClick}
                      className="relative h-16 w-16 rounded-full overflow-hidden bg-gray-200 hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 mr-4"
                    >
                      {imagePreview || user?.photoURL ? (
                        <img
                          src={imagePreview || user?.photoURL}
                          alt="Profile"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <UserCircleIcon className="h-full w-full text-gray-400" />
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-40 opacity-0 hover:opacity-100 transition-opacity">
                        <CameraIcon className="h-6 w-6 text-white" />
                      </div>
                    </button>
                  </div>
                  <div>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      onBlur={(e) => saveDisplayName(e.target.value)}
                      placeholder="Your name"
                      className="text-xl font-semibold text-gray-900 bg-transparent border-none focus:outline-none focus:ring-0 p-0 w-full"
                    />
                  </div>
                </div>
              </div>

              <div className="px-6 py-5">
                <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-gray-500">User ID</dt>
                    <dd className="mt-1 text-sm text-gray-900 font-mono break-all">
                      {user.uid}
                    </dd>
                  </div>

                  {/* The address the account was created with. Read-only: it is not a
                      stored credential but the input that derives the embedded wallet,
                      so it can't be renamed here. To sign in with a different address,
                      add one under Settings → Linked Emails. Absent for wallet-created
                      accounts and any predating the email sign-in path. */}
                  {userData?.signInEmail && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Signed up with</dt>
                      <dd className="mt-1 text-sm text-gray-900 break-all">
                        {userData.signInEmail}
                      </dd>
                    </div>
                  )}

                  {userData?.phone && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Phone</dt>
                      <dd className="mt-1 text-sm text-gray-900">{userData.phone}</dd>
                    </div>
                  )}

                  {userData?.created && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Account Created</dt>
                      <dd className="mt-1 text-sm text-gray-900">
                        {new Date(userData.created).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </dd>
                    </div>
                  )}

                  {userData?.stripeCreated && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Billing Account Created</dt>
                      <dd className="mt-1 text-sm text-gray-900">
                        {new Date(userData.stripeCreated).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            </div>

            {/* Notification Settings */}
            <div className="mt-8 bg-white shadow rounded-none overflow-hidden">
              <div className="px-6 py-5 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900">Notification Settings</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Manage where you receive notifications about your account.
                </p>
              </div>

              <div className="px-6 py-5 space-y-6">
                {/* Email Notification */}
                <div>
                  <div className="flex items-center justify-between">
                    <label htmlFor="notificationEmail" className="block text-sm font-medium text-gray-700">
                      Email for Notifications
                    </label>
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={notifyByEmail}
                        onChange={(e) => handleNotifyByEmailChange(e.target.checked)}
                        className="h-4 w-4 text-gray-600 focus:ring-gray-500 border-gray-300 rounded-none"
                      />
                      <span className="ml-2 text-sm text-gray-600">Enabled</span>
                    </label>
                  </div>
                  <input
                    type="email"
                    id="notificationEmail"
                    value={notificationEmail}
                    onChange={(e) => setNotificationEmail(e.target.value)}
                    onBlur={(e) => saveNotificationEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="mt-1 block w-full border border-gray-300 rounded-none shadow-sm py-2 px-3 focus:outline-none focus:ring-gray-500 focus:border-gray-500 sm:text-sm"
                  />
                </div>

                {/* Phone Notification */}
                <div>
                  <div className="flex items-center justify-between">
                    <label htmlFor="notificationPhone" className="block text-sm font-medium text-gray-700">
                      Phone for SMS Notifications
                    </label>
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={notifyByPhone}
                        onChange={(e) => handleNotifyByPhoneChange(e.target.checked)}
                        className="h-4 w-4 text-gray-600 focus:ring-gray-500 border-gray-300 rounded-none"
                      />
                      <span className="ml-2 text-sm text-gray-600">Enabled</span>
                    </label>
                  </div>
                  <input
                    type="tel"
                    id="notificationPhone"
                    value={notificationPhone}
                    onChange={handlePhoneChange}
                    onBlur={(e) => saveNotificationPhone(e.target.value)}
                    placeholder="+1 (555) 123-4567"
                    className="mt-1 block w-full border border-gray-300 rounded-none shadow-sm py-2 px-3 focus:outline-none focus:ring-gray-500 focus:border-gray-500 sm:text-sm"
                  />
                </div>
              </div>
            </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
