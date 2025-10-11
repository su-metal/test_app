"use client";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";

const markerIcon = L.icon({
    iconUrl: "https://unpkg.com/leaflet@1.9.3/dist/images/marker-icon.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
});

export default function MapView({
    lat, lng, name,
}: { lat: number; lng: number; name: string }) {
    const apiKey = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;

    // 0,0（未設定）なら名古屋駅にフォールバック
    const isZero = !lat && !lng;
    const center = isZero ? { lat: 35.171, lng: 136.881 } : { lat, lng };

    return (
        <MapContainer
            center={[center.lat, center.lng]}
            zoom={16}
            minZoom={2}
            maxZoom={19}
            scrollWheelZoom={false}
            // center変更時に確実に再初期化
            key={`${center.lat.toFixed(6)},${center.lng.toFixed(6)}`}
            style={{ height: "180px", width: "100%", borderRadius: "0.75rem" }}
        >
            <TileLayer
                // ← ここを修正（/tiles/や/256/を使わない）
                url={`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${apiKey}`}
                // 高解像度にしたい場合は上を @2x.png に変えてください
                // url={`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}@2x.png?key=${apiKey}`}
                attribution='&copy; OpenStreetMap contributors & MapTiler'
                crossOrigin={true}
                eventHandlers={{
                    tileerror: (e) => console.warn("Tile load error:", e),
                }}
            />
            <Marker position={[center.lat, center.lng]} icon={markerIcon}>
                <Popup>{name}</Popup>
            </Marker>
        </MapContainer>
    );
}
