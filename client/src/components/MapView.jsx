import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';

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

/**
 * markers: [{ id, lat, lng, emoji, variant, label }]
 * frame: points the view should keep in shot.
 */
export default function MapView({ center, markers = [], frame = [], onPick, className = '' }) {
  const framePoints = useMemo(() => frame.filter(Boolean), [frame]);
  return (
    <div className={`map ${className}`}>
      <MapContainer center={center} zoom={14} scrollWheelZoom zoomControl={false}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {markers.map((m) => (
          <Marker key={m.id} position={[m.lat, m.lng]} icon={pinIcon(m.emoji, m.variant)}>
            {m.label && <Tooltip direction="top" offset={[0, -18]}>{m.label}</Tooltip>}
          </Marker>
        ))}
        <ClickToPick onPick={onPick} />
        <Frame points={framePoints} />
      </MapContainer>
    </div>
  );
}
