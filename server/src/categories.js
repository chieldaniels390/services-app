// Prices are in minor units (cents, so 45000 = R450). They reflect typical 2025/26 South African
// rates for call-outs and hourly labour. The platform sets prices, like ride-hailing apps do,
// so customers get an upfront quote and pros compete on availability and rating.
export const CATEGORIES = [
  { id: 'plumbing', name: 'Plumbing', icon: '🔧', description: 'Leaks, blocked drains, geysers, taps, toilets', callout: 45000, hourly: 55000 },
  { id: 'electrical', name: 'Electrical', icon: '⚡', description: 'Plugs, lights, DB boards, COCs, rewiring', callout: 50000, hourly: 60000 },
  { id: 'cleaning', name: 'Cleaning', icon: '🧹', description: 'Home, move-out and deep cleans', callout: 10000, hourly: 15000 },
  { id: 'locksmith', name: 'Locksmith', icon: '🔑', description: 'Lockouts, lock changes, key cutting, gate locks', callout: 55000, hourly: 50000 },
  { id: 'handyman', name: 'Handyman', icon: '🛠️', description: 'Furniture assembly, TV mounting, small repairs', callout: 30000, hourly: 35000 },
  { id: 'hvac', name: 'Aircon & Heating', icon: '❄️', description: 'Aircon install, servicing and regassing, heaters', callout: 65000, hourly: 70000 },
  { id: 'painting', name: 'Painting', icon: '🎨', description: 'Interior and exterior painting, touch-ups', callout: 30000, hourly: 35000 },
  { id: 'appliances', name: 'Appliance Repair', icon: '🔌', description: 'Washing machines, fridges, stoves, dishwashers', callout: 45000, hourly: 50000 },
  { id: 'pest-control', name: 'Pest Control', icon: '🐜', description: 'Cockroaches, rodents, termites, bees', callout: 50000, hourly: 55000 },
  { id: 'gardening', name: 'Gardening', icon: '🌿', description: 'Lawn mowing, hedge trimming, garden refuse', callout: 15000, hourly: 18000 },
];
