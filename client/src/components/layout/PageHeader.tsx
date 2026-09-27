import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export interface Breadcrumb {
  label: string;
  /** A link target. The final crumb is usually left out and given as `current`. */
  to?: string;
}

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: readonly Breadcrumb[];
  className?: string;
}

/** The heading block every page opens with: what this is, and what you can do. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={["page-header", className]
        .filter((value): value is string => value !== null && value !== undefined)
        .join(" ")}
    >
      <div className="page-header__text">
        {breadcrumbs === undefined || breadcrumbs.length === 0 ? null : (
          <nav aria-label="Breadcrumb">
            <ol className="breadcrumbs">
              {breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <li key={`${crumb.label}-${index}`} className="cluster cluster--tight">
                    {isLast ? null : <span aria-hidden="true">/</span>}
                    {crumb.to === undefined || isLast ? (
                      <span aria-current={isLast ? "page" : undefined}>{crumb.label}</span>
                    ) : (
                      <Link to={crumb.to}>{crumb.label}</Link>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        <h1 className="page-header__title">{title}</h1>
        {description === undefined ? null : (
          <p className="page-header__description">{description}</p>
        )}
      </div>

      {actions === undefined ? null : <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
