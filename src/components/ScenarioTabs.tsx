import { Check, FlaskConical } from "lucide-react";
import type { TraceScenario } from "../types/trace";

interface ScenarioTabsProps {
  scenarios: TraceScenario[];
  activeId: string;
  onChange: (id: string) => void;
}

export function ScenarioTabs({
  scenarios,
  activeId,
  onChange,
}: ScenarioTabsProps) {
  return (
    <nav className="scenario-tabs" aria-label="确定性演示轨迹">
      <div className="scenario-tabs__label">
        <FlaskConical size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>
          <small>DETERMINISTIC TRACE</small>
          演示轨迹
        </span>
      </div>
      <div className="scenario-tabs__items">
        {scenarios.map((scenario) => {
          const active = scenario.id === activeId;
          return (
            <button
              type="button"
              className={active ? "scenario-tab scenario-tab--active" : "scenario-tab"}
              onClick={() => onChange(scenario.id)}
              aria-current={active ? "page" : undefined}
              title={scenario.description}
              key={scenario.id}
            >
              <span>{scenario.name}</span>
              <small>{scenario.shortName}</small>
              {active ? (
                <Check size={14} strokeWidth={2.2} aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
