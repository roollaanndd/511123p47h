import React, { useState } from 'react';
import { Download, FileText, Loader2, Printer } from 'lucide-react';
import type { QuotationSlipData } from '../../services/quotationSlipPdf';
import { B2BInvoiceOptions, generateB2BInvoicePDF } from '../../services/b2bInvoicePdf';

export interface B2BInvoiceButtonProps {
  data?: QuotationSlipData | null;
  getData?: () => QuotationSlipData | null;
  mode?: 'INVOICE' | 'QUOTATION';
  lang?: 'en' | 'id';
  disabled?: boolean;
  className?: string;
  invoiceOptions?: Omit<B2BInvoiceOptions, 'mode' | 'outputAction'>;
}

export const B2BInvoiceButton: React.FC<B2BInvoiceButtonProps> = ({
  data,
  getData,
  mode = 'INVOICE',
  lang = 'id',
  disabled = false,
  className = '',
  invoiceOptions,
}) => {
  const [loadingAction, setLoadingAction] = useState<'save' | 'print' | null>(null);

  const handleAction = async (outputAction: 'save' | 'print') => {
    if (disabled || loadingAction) return;
    const slip = getData ? getData() : data;
    if (!slip) return;
    setLoadingAction(outputAction);
    try {
      await generateB2BInvoicePDF(slip, {
        ...invoiceOptions,
        mode,
        outputAction,
      });
    } catch (err) {
      console.error('[B2BInvoiceButton] Failed to generate PDF:', err);
    } finally {
      setLoadingAction(null);
    }
  };

  const isDisabled = disabled || (!data && !getData);
  const label =
    mode === 'QUOTATION'
      ? lang === 'id'
        ? 'Quotation 1-Hal'
        : 'Quotation 1-Page'
      : lang === 'id'
        ? 'Invoice PDF'
        : 'Invoice PDF';
  const printTitle =
    mode === 'QUOTATION'
      ? lang === 'id'
        ? 'Cetak Quotation'
        : 'Print Quotation'
      : lang === 'id'
        ? 'Cetak Invoice'
        : 'Print Invoice';

  return (
    <div
      className={`inline-flex items-center rounded-xl border border-emerald-600/25 bg-white/75 backdrop-blur-md shadow-sm ring-1 ring-emerald-500/10 overflow-hidden transition-all ${
        isDisabled ? 'opacity-50 pointer-events-none' : 'hover:border-emerald-600/45 hover:shadow-md'
      } ${className}`}
    >
      <button
        type="button"
        onClick={() => handleAction('save')}
        disabled={isDisabled || loadingAction !== null}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#0D6938] hover:bg-emerald-50/80 active:bg-emerald-100/80 transition-colors cursor-pointer"
        title={lang === 'id' ? `Unduh ${label}` : `Download ${label}`}
      >
        {loadingAction === 'save' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0D6938]" />
        ) : (
          <FileText className="w-3.5 h-3.5 text-[#0D6938]" />
        )}
        <span>{label}</span>
        <Download className="w-3 h-3 text-[#70C93A]" />
      </button>

      <span className="w-px h-5 bg-emerald-600/20" aria-hidden="true" />

      <button
        type="button"
        onClick={() => handleAction('print')}
        disabled={isDisabled || loadingAction !== null}
        className="inline-flex items-center justify-center px-2.5 py-2 text-xs font-semibold text-[#0D6938] hover:bg-emerald-50/80 active:bg-emerald-100/80 transition-colors cursor-pointer"
        title={printTitle}
        aria-label={printTitle}
      >
        {loadingAction === 'print' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0D6938]" />
        ) : (
          <Printer className="w-3.5 h-3.5 text-[#0D6938]" />
        )}
      </button>
    </div>
  );
};

export default B2BInvoiceButton;
