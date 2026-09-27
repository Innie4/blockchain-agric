import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface TabDefinition {
  id: string;
  label: string;
  icon?: IconName;
  content: ReactNode;
}

export interface TabsProps {
  /** Names the tab list, e.g. "Product sections". */
  label: string;
  tabs: readonly TabDefinition[];
  activeId: string;
  onChange: (id: string) => void;
}

function panelId(tabId: string): string {
  return `tabpanel-${tabId}`;
}

function tabId(tabId: string): string {
  return `tab-${tabId}`;
}

/**
 * Tabs that behave like tabs: arrow keys move between them, Home and End jump to
 * the ends, and only the selected tab is in the tab order. Buttons are tracked
 * in a map so focus can move without querying the DOM by identifier.
 */
export function Tabs({ label, tabs, activeId, onChange }: TabsProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  function focusTab(id: string): void {
    buttons.current.get(id)?.focus();
  }

  function select(tab: TabDefinition): void {
    onChange(tab.id);
  }

  function move(currentIndex: number, direction: 1 | -1): void {
    if (tabs.length === 0) return;
    const next = (currentIndex + direction + tabs.length) % tabs.length;
    const target = tabs[next];
    if (target === undefined) return;
    select(target);
    focusTab(target.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const currentIndex = tabs.findIndex((tab) => tab.id === activeId);
    if (currentIndex < 0) return;
    const first = tabs[0];
    const last = tabs[tabs.length - 1];

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        move(currentIndex, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        move(currentIndex, -1);
        break;
      case "Home":
        if (first === undefined) break;
        event.preventDefault();
        select(first);
        focusTab(first.id);
        break;
      case "End":
        if (last === undefined) break;
        event.preventDefault();
        select(last);
        focusTab(last.id);
        break;
      default:
        break;
    }
  }

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <div>
      <div className="tabs__list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === active?.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              className="tab"
              ref={(element) => {
                if (element === null) buttons.current.delete(tab.id);
                else buttons.current.set(tab.id, element);
              }}
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab)}
            >
              {tab.icon === undefined ? null : <Icon name={tab.icon} size={16} />}
              {tab.label}
            </button>
          );
        })}
      </div>

      {active === undefined ? null : (
        <div
          className="tab-panel"
          role="tabpanel"
          id={panelId(active.id)}
          aria-labelledby={tabId(active.id)}
          tabIndex={0}
        >
          {active.content}
        </div>
      )}
    </div>
  );
}
