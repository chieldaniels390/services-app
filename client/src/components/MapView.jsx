import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { Circle, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { useSession } from '../session.jsx';

const iconCache = new Map();
function pinIcon(emoji, variant = '') {
  const key = `${emoji}|${variant}`;
  if (!iconCache.has(key)) {
    iconCache.set(key, L.divIcon({
      className: '',
      html: `<div class="map-pin ${variant}"><span>${emoji}</span></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    }));
  }
  return iconCache.get(key);
}

function ClickToPick({ onPick }) {
  useMapEvents({ click: (e) => onPick?.({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

/**
 * Keeps the points that matter in view. Only moves the map when one of them is off-screen,
 * so live tracking doesn't fight the user's panning. Zoom changes are not animated because
 * Leaflet drops a new zoom request while a previous zoom animation is still running.
 */
function Frame({ points }) {
  const map = useMap();
  const key = points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|');
  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points);
    if (map.getBounds().pad(-0.1).contains(bounds)) return;
    if (points.length === 1) map.panTo(points[0]);
    else map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/** Jumps to street level on a point the user explicitly chose (an address or their GPS fix). */
function Focus({ point }) {
  const map = useMap();
  useEffect(() => {
    if (point) map.setView(point, Math.max(map.getZoom(), 16), { animate: false });
  }, [point, map]);
  return null;
}

/**
 * markers: [{ id, lat, lng, emoji, variant, label }]
 * frame: points the view should keep in shot.
 * circles: [{ id, lat, lng, radiusKm }] - e.g. a pro's service area.
 */
export default function MapView({ center, markers = [], circles = [], frame = [], focus, onPick, className = '' }) {
  const framePoints = useMemo(() => frame.filter(Boolean), [frame]);
  const { map: tiles } = useSession().config;
  return (
    <div className={`map ${tiles.dark ? 'dark-tiles' : ''} ${className}`}>
      <MapContainer center={center} zoom={14} maxZoom={tiles.maxZoom} scrollWheelZoom zoomControl={false}>
        <TileLayer url={tiles.tileUrl} subdomains={tiles.subdomains} attribution={tiles.attribution} maxZoom={tiles.maxZoom} />
        {circles.map((c) => (
          <Circle
            key={c.id}
            center={[c.lat, c.lng]}
            radius={c.radiusKm * 1000}
            pathOptions={{ color: '#2dd4bf', weight: 2, fillColor: '#2dd4bf', fillOpacity: 0.1 }}
            interactive={false}
          />
        ))}
        {markers.map((m) => (
          <Marker key={m.id} position={[m.lat, m.lng]} icon={pinIcon(m.emoji, m.variant)}>
            {m.label && <Tooltip direction="top" offset={[0, -18]}>{m.label}</Tooltip>}
          </Marker>
        ))}
        <ClickToPick onPick={onPick} />
        <Frame points={framePoints} />
        {/* After Frame, so an explicit focus wins over automatic framing in the same render. */}
        <Focus point={focus} />
      </MapContainer>
    </div>
  );
}

/** Points on the edge of a circle, so a map can frame the whole service area. */
export function circleBounds({ lat, lng, radiusKm }) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [{ lat: lat + dLat, lng }, { lat: lat - dLat, lng }, { lat, lng: lng + dLng }, { lat, lng: lng - dLng }];
}
