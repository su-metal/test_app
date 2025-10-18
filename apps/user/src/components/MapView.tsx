"use client";
import React from "react";

export default function MapView({
    lat,
    lng,
    name,
    address,
}: { lat?: number; lng?: number; name: string; address?: string | null }) {
    // 住所を最優先に埋め込み。無ければ lat,lng。さらに無ければ名古屋駅。
    const hasLL = typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);
    const query = (address && address.trim()) || (hasLL ? `${lat},${lng}` : '名古屋駅');
    const src = `https://www.google.com/maps?q=${encodeURIComponent(query)}&hl=ja&z=16&output=embed`;

    return (
        <div style={{ height: "180px", width: "100%", borderRadius: "0.75rem", overflow: 'hidden' }}>
            <iframe
                title={`地図: ${name}`}
                src={src}
                width="100%"
                height="180"
                style={{ border: 0 }}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                aria-label={`Googleマップで ${name} の位置を表示`}
            />
        </div>
    );
}
