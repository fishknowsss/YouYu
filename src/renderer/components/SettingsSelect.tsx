import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export type SettingsSelectOption<T extends string | number> = {
  value: T;
  label: string;
};

type SettingsSelectProps<T extends string | number> = {
  label: string;
  value: T;
  options: readonly SettingsSelectOption<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
};

export function SettingsSelect<T extends string | number>({
  label,
  value,
  options,
  disabled = false,
  onChange
}: SettingsSelectProps<T>) {
  const labelId = useId();
  const valueId = useId();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => Object.is(option.value, value))
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selectedOption = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;

    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeFromOutside);
    return () => document.removeEventListener('pointerdown', closeFromOutside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(
    () => () => {
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    },
    []
  );

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    setOpen(false);
    setActiveIndex(index);
    if (!Object.is(option.value, value)) onChange(option.value);
    triggerRef.current?.focus();
  }

  function moveActive(offset: -1 | 1) {
    if (options.length === 0) return;
    setActiveIndex((current) => (current + offset + options.length) % options.length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || options.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setActiveIndex(selectedIndex);
        setOpen(true);
      } else {
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
      setOpen(true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) commit(activeIndex);
      else setOpen(true);
      return;
    }
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      setActiveIndex(selectedIndex);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;

    typeaheadRef.current += event.key.toLocaleLowerCase('zh-CN');
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = setTimeout(() => {
      typeaheadRef.current = '';
    }, 600);
    const matchIndex = options.findIndex((option) =>
      option.label.toLocaleLowerCase('zh-CN').startsWith(typeaheadRef.current)
    );
    if (matchIndex >= 0) {
      event.preventDefault();
      setActiveIndex(matchIndex);
      setOpen(true);
    }
  }

  return (
    <div className="field settings-control-field">
      <span id={labelId}>{label}</span>
      <div ref={rootRef} className={`settings-select${open ? ' is-open' : ''}`}>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          className="settings-select-trigger"
          aria-labelledby={`${labelId} ${valueId}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
          disabled={disabled}
          onClick={() => {
            setActiveIndex(selectedIndex);
            setOpen((current) => !current);
          }}
          onKeyDown={handleKeyDown}
        >
          <span id={valueId} className="settings-select-value">
            {selectedOption?.label ?? ''}
          </span>
          <span className="settings-select-chevron" aria-hidden="true" />
        </button>
        {open && (
          <div id={listboxId} className="settings-select-listbox" role="listbox" aria-labelledby={labelId}>
            {options.map((option, index) => (
              <div
                id={`${listboxId}-option-${index}`}
                key={`${typeof option.value}:${String(option.value)}`}
                role="option"
                aria-selected={Object.is(option.value, value)}
                className={`settings-select-option${activeIndex === index ? ' is-active' : ''}`}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => commit(index)}
              >
                {option.label}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
