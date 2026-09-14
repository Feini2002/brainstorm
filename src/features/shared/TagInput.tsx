'use client';

/**
 * Tag/keyword input (T017).
 *
 * A chip editor rather than a comma-separated string: the value is a real array,
 * matching the DTO, so the user can see and remove each item. Normalization
 * (NFKC, case folding, whitespace collapse, dedupe) happens in the domain layer
 * on both sides, so what the user types and what the server stores agree.
 *
 * Enter and comma commit; Backspace on an empty field removes the last chip.
 * Enter during IME composition commits the candidate, not the tag (T013-R03's
 * rule applied here too).
 */
import { useCallback, useRef, useState } from 'react';

import { LIMITS } from '@/domain/limits';
import { normalizeTagList } from '@/domain/tags';
import { TextInput } from '@/components/ui/primitives';

export interface TagInputProps {
  id: string;
  testId?: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** Tags use `tagsPerItem`; keywords use `keywordsPerItem`. */
  limit?: number;
  placeholder?: string;
  disabled?: boolean;
}

export function TagInput({
  id,
  testId,
  value,
  onChange,
  limit = LIMITS.tagsPerItem,
  placeholder = '回车添加',
  disabled = false,
}: TagInputProps) {
  const [pending, setPending] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = useCallback(
    (raw: string) => {
      const candidate = raw.trim();
      if (candidate.length === 0) return;
      // Normalizing through the shared rule means a chip the UI shows is a tag
      // the server will accept, and duplicates collapse instead of doubling.
      const { labels } = normalizeTagList([...value, candidate]);
      onChange(labels.slice(0, limit));
      setPending('');
    },
    [limit, onChange, value],
  );

  const remove = useCallback(
    (label: string) => {
      onChange(value.filter((entry) => entry !== label));
    },
    [onChange, value],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Never commit while the IME is composing a candidate.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        commit(pending);
        return;
      }
      if (event.key === 'Backspace' && pending.length === 0 && value.length > 0) {
        event.preventDefault();
        remove(value[value.length - 1]);
      }
    },
    [commit, pending, remove, value],
  );

  const atLimit = value.length >= limit;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((label) => (
          <span
            key={label}
            data-testid={testId ? `${testId}-chip` : undefined}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--surface-raised)] px-2 py-0.5 text-xs text-[var(--ink)]"
          >
            {label}
            <button
              type="button"
              className="text-[var(--ink-muted)] hover:text-[var(--danger)]"
              aria-label={`移除 ${label}`}
              disabled={disabled}
              onClick={() => remove(label)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <TextInput
        id={id}
        ref={inputRef}
        {...(testId ? { 'data-testid': testId } : {})}
        value={pending}
        disabled={disabled || atLimit}
        placeholder={atLimit ? `最多 ${limit} 个` : placeholder}
        onChange={(event) => setPending(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(pending)}
      />
    </div>
  );
}
