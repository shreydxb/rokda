import { render } from '@testing-library/react';
import { ScopeProvider } from '../lib/ScopeContext';
import { CurrencyProvider } from '../lib/CurrencyContext';

// Screens read the household scope and display currency from context. Tests
// render through the real providers so a component test exercises the same
// code path the app does.
export function renderScreen(ui) {
  return render(
    <ScopeProvider>
      <CurrencyProvider>{ui}</CurrencyProvider>
    </ScopeProvider>,
  );
}
