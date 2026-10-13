import { useState, useEffect } from 'react';
import { DocumentArrowDownIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { paymentsGet } from '../../utils/payments-client';

interface Invoice {
  id: string;
  date: string;
  amount: number;
  status: 'paid' | 'pending' | 'failed' | 'completed';
  description: string;
  invoicePdf?: string;
  type: 'subscription' | 'overage' | 'one-time';
}

export default function BillingHistory() {
  const { user } = useGraffiticodeAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'subscription' | 'overage'>('all');

  useEffect(() => {
    if (user) fetchInvoices();
  }, [user]);

  const fetchInvoices = async () => {
    try {
      const response = await paymentsGet(user, 'invoices');
      // Extract invoices array from response object
      setInvoices(response.data.invoices || []);
    } catch (error) {
      console.error('Error fetching invoices:', error);
      // Set empty array on error - no mock data
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadInvoice = async (invoiceId: string, invoicePdf?: string) => {
    if (invoicePdf) {
      // Open Stripe invoice PDF in new tab
      window.open(invoicePdf, '_blank');
    } else {
      // No invoice PDF available
      alert('Invoice PDF is not available for this transaction.');
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 bg-gray-200 rounded-none"></div>
        ))}
      </div>
    );
  }

  const filteredInvoices = filter === 'all'
    ? invoices
    : invoices.filter(invoice => invoice.type === filter);

  return (
    <div>
      <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">Invoices</h3>
      {/* Filter Tabs */}
      <div className="mb-6">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8" aria-label="Tabs">
            {['all', 'subscription', 'overage'].map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab as any)}
                className={`${
                  filter === tab
                    ? 'border-gray-500 text-gray-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm capitalize`}
              >
                {tab === 'all' ? 'All Transactions' : `${tab} Charges`}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Invoices Table */}
      {filteredInvoices.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">No billing history to display.</p>
        </div>
      ) : (
        <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-none">
          <table className="min-w-full divide-y divide-gray-300">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Description
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredInvoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {new Date(invoice.date).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {invoice.description}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      invoice.type === 'subscription'
                        ? 'bg-blue-100 text-blue-800'
                        : invoice.type === 'overage'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-purple-100 text-purple-800'
                    }`}>
                      {invoice.type}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center text-sm ${
                      invoice.status === 'paid'
                        ? 'text-green-600'
                        : invoice.status === 'pending'
                        ? 'text-yellow-600'
                        : 'text-red-600'
                    }`}>
                      {invoice.status === 'paid' && <CheckCircleIcon className="w-4 h-4 mr-1" />}
                      {invoice.status === 'failed' && <XCircleIcon className="w-4 h-4 mr-1" />}
                      {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${invoice.amount.toFixed(2)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => handleDownloadInvoice(invoice.id, invoice.invoicePdf)}
                      className={`inline-flex items-center ${
                        invoice.invoicePdf
                          ? 'text-gray-600 hover:text-gray-900'
                          : 'text-gray-400 cursor-not-allowed'
                      }`}
                      disabled={!invoice.invoicePdf}
                      title={invoice.invoicePdf ? 'Download invoice' : 'Invoice not available'}
                    >
                      <DocumentArrowDownIcon className="w-4 h-4 mr-1" />
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Summary */}
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-3">
        <div className="bg-white overflow-hidden shadow rounded-none">
          <div className="px-4 py-5 sm:p-6">
            <dt className="text-sm font-medium text-gray-500 truncate">
              Total Spent (This Month)
            </dt>
            <dd className="mt-1 text-3xl font-semibold text-gray-900">
              ${filteredInvoices
                .filter(inv => {
                  const invoiceDate = new Date(inv.date);
                  const now = new Date();
                  return invoiceDate.getMonth() === now.getMonth() &&
                         invoiceDate.getFullYear() === now.getFullYear() &&
                         inv.status === 'paid';
                })
                .reduce((sum, inv) => sum + inv.amount, 0)
                .toFixed(2)}
            </dd>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-none">
          <div className="px-4 py-5 sm:p-6">
            <dt className="text-sm font-medium text-gray-500 truncate">
              Overage Charges (This Month)
            </dt>
            <dd className="mt-1 text-3xl font-semibold text-gray-900">
              ${filteredInvoices
                .filter(inv => {
                  const invoiceDate = new Date(inv.date);
                  const now = new Date();
                  return invoiceDate.getMonth() === now.getMonth() &&
                         invoiceDate.getFullYear() === now.getFullYear() &&
                         inv.type === 'overage' &&
                         inv.status === 'paid';
                })
                .reduce((sum, inv) => sum + inv.amount, 0)
                .toFixed(2)}
            </dd>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-none">
          <div className="px-4 py-5 sm:p-6">
            <dt className="text-sm font-medium text-gray-500 truncate">
              Total All Time
            </dt>
            <dd className="mt-1 text-3xl font-semibold text-gray-900">
              ${filteredInvoices
                .filter(inv => inv.status === 'paid')
                .reduce((sum, inv) => sum + inv.amount, 0)
                .toFixed(2)}
            </dd>
          </div>
        </div>
      </div>
    </div>
  );
}