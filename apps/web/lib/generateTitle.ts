import type { Stop, Customer } from './types';

/**
 * Generates a load title from broker + stops.
 * Format: "BrokerName: PickupCity → DeliveryCity"
 * If unique cities > 3: "BrokerName: PickupCity → DeliveryCity (Multi-Stop)"
 *
 * Relies on `stop.city` being set by the AI parser. Stops without a city are skipped.
 */
export function generateLoadTitle(
  broker: string | undefined,
  stops: Stop[],
  customers: Customer[],
): string {
  const customer = broker ? customers.find(c =>
    c.name === broker || c.aliases.includes(broker),
  ) : undefined;
  const brokerDisplay = customer?.shortName ?? broker ?? '';

  const revenueCities = stops
    .filter(s => s.type === 'pickup' || s.type === 'delivery')
    .map(s => s.city?.trim())
    .filter((c): c is string => !!c);

  if (revenueCities.length === 0) return brokerDisplay || '';

  const pickupCity   = revenueCities[0];
  const deliveryCity = revenueCities[revenueCities.length - 1];

  // Deduplicate consecutive cities
  const unique = revenueCities.filter((c, i) => c !== revenueCities[i - 1]);

  const routePart = unique.length <= 3
    ? unique.join(' → ')
    : `${pickupCity} → ${deliveryCity} (Multi-Stop)`;

  return brokerDisplay ? `${brokerDisplay}: ${routePart}` : routePart;
}
