/**
 * Shared catalog for Manual Entry and Bulk Generate.
 * `id` is the ISO message definition version; `bulkId` is the backend bulk_generator key.
 */
export interface ManualEntryMessage {
  id: string;
  name: string;
  type: 'pacs' | 'camt' | 'pain';
  route?: string;
  bulkId: string;
}

export const MANUAL_ENTRY_MESSAGES: ManualEntryMessage[] = [
  // PACS
  { id: 'pacs.008.001.08', name: 'Customer Credit Transfer', type: 'pacs', route: 'pacs8', bulkId: 'pacs.008' },
  { id: 'pacs.003.001.08', name: 'Customer Direct Debit', type: 'pacs', route: 'pacs3', bulkId: 'pacs.003' },
  { id: 'pacs.009.001.08', name: 'FI Credit Transfer', type: 'pacs', route: 'pacs9', bulkId: 'pacs.009' },
  { id: 'pacs.009.001.08_ADV', name: 'FI Credit Transfer (Adv)', type: 'pacs', route: 'pacs9adv', bulkId: 'pacs.009.adv' },
  { id: 'pacs.009.001.08 COV', name: 'FI Credit Transfer (Cov)', type: 'pacs', route: 'pacs9cov', bulkId: 'pacs.009.cov' },
  { id: 'pacs.004.001.09', name: 'Payment Return', type: 'pacs', route: 'pacs4', bulkId: 'pacs.004' },
  { id: 'pacs.002.001.10', name: 'Payment Status Report', type: 'pacs', route: 'pacs2', bulkId: 'pacs.002' },
  { id: 'pacs.010.001.10', name: 'Interbank Direct Debit', type: 'pacs', route: 'pacs10', bulkId: 'pacs.010' },
  { id: 'pacs.010.001.03', name: 'Margin Collection', type: 'pacs', route: 'pacs10v3', bulkId: 'pacs.010.v3' },
  // CAMT
  { id: 'camt.057.001.06', name: 'Notification to Receive', type: 'camt', route: 'camt57', bulkId: 'camt.057' },
  { id: 'camt.052.001.08', name: 'Bank To Customer Report', type: 'camt', route: 'camt052', bulkId: 'camt.052' },
  { id: 'camt.053.001.08', name: 'Bank To Customer Statement', type: 'camt', route: 'camt053', bulkId: 'camt.053' },
  { id: 'camt.054.001.08', name: 'Debit Credit Notification', type: 'camt', route: 'camt054', bulkId: 'camt.054' },
  { id: 'camt.055.001.08', name: 'Customer Payment Cancellation', type: 'camt', route: 'camt055', bulkId: 'camt.055' },
  { id: 'camt.056.001.08', name: 'FI To FI Payment Cancellation', type: 'camt', route: 'camt056', bulkId: 'camt.056' },
  // PAIN
  { id: 'pain.001.001.09', name: 'Credit Transfer Initiation', type: 'pain', route: 'pain001', bulkId: 'pain.001' },
  { id: 'pain.002.001.10', name: 'Payment Status Report', type: 'pain', route: 'pain002', bulkId: 'pain.002' },
  { id: 'pain.008.001.08', name: 'Direct Debit Initiation', type: 'pain', route: 'pain008', bulkId: 'pain.008' },
];

/** Messages shown in the manual-entry catalog (dedicated form routes only). */
export const POPULAR_MANUAL_ENTRY_MESSAGES = MANUAL_ENTRY_MESSAGES.filter(m => !!m.route);
