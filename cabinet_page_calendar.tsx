'use client';

import { useEffect, useState, useMemo } from 'react';
import { useAuth } from '@/lib/auth-context';
import { getCalendar, type CalendarData, type CalendarBookingItem, type CalendarClosureItem } from '@/lib/api';
import Link from 'next/link';

export default function CalendarPage() {
  const { token, user } = useAuth();
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [selectedBooking, setSelectedBooking] = useState<CalendarBookingItem | null>(null);
  const [currentDate, setCurrentDate] = useState(() => new Date());

  // Calculate month boundaries for the current selected date
  const { from, to, daysInMonth, monthLabel } = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0); // last day of month

    const fromStr = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const toStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

    const days: { dateStr: string; dayNum: number; dayName: string; isWeekend: boolean; isToday: boolean }[] = [];
    const todayStr = new Date().toISOString().slice(0, 10);
    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

    for (let d = 1; d <= endDate.getDate(); d++) {
      const dateObj = new Date(year, month, d);
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayOfWeek = dateObj.getDay();
      days.push({
        dateStr,
        dayNum: d,
        dayName: dayNames[dayOfWeek],
        isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
        isToday: dateStr === todayStr,
      });
    }

    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];

    return {
      from: fromStr,
      to: toStr,
      daysInMonth: days,
      monthLabel: `${monthNames[month]} ${year}`,
    };
  }, [currentDate]);

  const load = () => {
    if (!token) return;
    setLoading(true);
    setErr('');
    getCalendar(token, from, to)
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [token, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const prevMonth = () => {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  };

  const goToday = () => {
    setCurrentDate(new Date());
  };

  // Map bookings and closures by propertyId
  const { bookingsByProp, closuresByProp } = useMemo(() => {
    const bMap = new Map<string, CalendarBookingItem[]>();
    const cMap = new Map<string, CalendarClosureItem[]>();

    if (data) {
      for (const b of data.bookings) {
        const arr = bMap.get(b.propertyId) || [];
        arr.push(b);
        bMap.set(b.propertyId, arr);
      }
      for (const c of data.closures) {
        const arr = cMap.get(c.propertyId) || [];
        arr.push(c);
        cMap.set(c.propertyId, arr);
      }
    }
    return { bookingsByProp: bMap, closuresByProp: cMap };
  }, [data]);

  return (
    <div style={{ maxWidth: '100%' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1>📅 Календарь занятости (Шахматка)</h1>
          <p className="subtitle">
            {user?.pms_connected
              ? `Синхронизировано в реальном времени с ${user.pms_provider === 'bnovo' ? 'Bnovo' : 'RealtyCalendar'}`
              : 'Подключите PMS в настройках для автоматической шахматки'}
          </p>
        </div>

        {/* Month switcher */}
        <div className="flex items-center gap-3">
          <button onClick={prevMonth} className="btn btn-secondary btn-sm">
            ←
          </button>
          <span style={{ fontWeight: 700, fontSize: '1.05rem', minWidth: '150px', textAlign: 'center' }}>
            {monthLabel}
          </span>
          <button onClick={nextMonth} className="btn btn-secondary btn-sm">
            →
          </button>
          <button onClick={goToday} className="btn btn-ghost btn-sm">
            Сегодня
          </button>
          <button onClick={load} className="btn btn-secondary btn-sm" disabled={loading}>
            🔄
          </button>
        </div>
      </div>

      {!user?.pms_connected && (
        <div className="card mb-6" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <h3 style={{ color: 'var(--warning)', marginBottom: 8 }}>PMS не подключена</h3>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
            Чтобы шахматка заполнялась автоматически всеми бронями и закрытыми датами, подключите Bnovo или RealtyCalendar.
          </p>
          <Link href="/settings/pms" className="btn btn-primary btn-sm">
            Подключить PMS
          </Link>
        </div>
      )}

      {err && <div className="form-error mb-4">{err}</div>}

      {loading && !data && (
        <div className="loading-page" style={{ minHeight: '300px' }}>
          <div className="spinner" />
        </div>
      )}

      {data && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Chessboard Container */}
          <div style={{ overflowX: 'auto', maxWidth: '100%', maxHeight: '75vh', overflowY: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: `${daysInMonth.length * 40 + 260}px` }}>
              <thead>
                <tr style={{ background: 'var(--bg-secondary)', position: 'sticky', top: 0, zIndex: 10 }}>
                  {/* Property Header */}
                  <th
                    style={{
                      position: 'sticky',
                      left: 0,
                      zIndex: 20,
                      background: 'var(--bg-secondary)',
                      width: '260px',
                      minWidth: '260px',
                      padding: '12px 16px',
                      textAlign: 'left',
                      borderBottom: '1px solid var(--border-primary)',
                      borderRight: '1px solid var(--border-primary)',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      color: 'var(--text-muted)',
                    }}
                  >
                    Объект ({data.properties.length})
                  </th>

                  {/* Day Columns Header */}
                  {daysInMonth.map((d) => (
                    <th
                      key={d.dateStr}
                      style={{
                        width: '38px',
                        minWidth: '38px',
                        padding: '8px 2px',
                        textAlign: 'center',
                        borderBottom: '1px solid var(--border-primary)',
                        borderRight: '1px solid rgba(255,255,255,0.04)',
                        background: d.isToday
                          ? 'var(--accent-subtle)'
                          : d.isWeekend
                            ? 'rgba(255,255,255,0.02)'
                            : 'transparent',
                        color: d.isToday
                          ? 'var(--accent-hover)'
                          : d.isWeekend
                            ? 'var(--text-muted)'
                            : 'var(--text-secondary)',
                      }}
                    >
                      <div style={{ fontSize: '0.7rem', fontWeight: 500 }}>{d.dayName}</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700, marginTop: '2px' }}>{d.dayNum}</div>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {data.properties.map((prop) => {
                  const propBookings = bookingsByProp.get(prop.id) || [];
                  const propClosures = closuresByProp.get(prop.id) || [];

                  return (
                    <tr
                      key={prop.id}
                      style={{
                        borderBottom: '1px solid var(--border-primary)',
                        height: '52px',
                      }}
                    >
                      {/* Left Fixed Column: Property Info */}
                      <td
                        style={{
                          position: 'sticky',
                          left: 0,
                          zIndex: 5,
                          background: 'var(--bg-card)',
                          padding: '8px 12px',
                          borderRight: '1px solid var(--border-primary)',
                          verticalAlign: 'middle',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          {prop.photos && prop.photos.length > 0 ? (
                            <img
                              src={prop.photos[0]}
                              alt={prop.title}
                              style={{
                                width: '38px',
                                height: '38px',
                                borderRadius: '6px',
                                objectFit: 'cover',
                                flexShrink: 0,
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: '38px',
                                height: '38px',
                                borderRadius: '6px',
                                background: 'var(--bg-glass)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '1.1rem',
                                flexShrink: 0,
                              }}
                            >
                              🏠
                            </div>
                          )}
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                              title={prop.title}
                            >
                              {prop.title}
                            </div>
                            <div
                              style={{
                                fontSize: '0.72rem',
                                color: 'var(--text-muted)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {prop.photos.length ? `${prop.photos.length} фото` : 'ID ' + prop.id}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Day Cells */}
                      {daysInMonth.map((day) => {
                        // Check if day is part of any booking
                        const booking = propBookings.find((b) => {
                          const checkIn = b.checkIn;
                          const checkOut = b.checkOut;
                          return day.dateStr >= checkIn && day.dateStr < checkOut;
                        });

                        // Check if day is part of closure
                        const closure = !booking && propClosures.find((c) => {
                          return day.dateStr >= c.checkIn && day.dateStr <= c.checkOut;
                        });

                        const isStart = booking && booking.checkIn === day.dateStr;
                        const isClosureStart = closure && closure.checkIn === day.dateStr;

                        return (
                          <td
                            key={day.dateStr}
                            style={{
                              padding: '2px 1px',
                              textAlign: 'center',
                              borderRight: '1px solid rgba(255,255,255,0.03)',
                              background: day.isToday
                                ? 'var(--accent-subtle)'
                                : day.isWeekend
                                  ? 'rgba(255,255,255,0.015)'
                                  : 'transparent',
                              verticalAlign: 'middle',
                            }}
                          >
                            {booking ? (
                              <div
                                onClick={() => setSelectedBooking(booking)}
                                style={{
                                  height: '38px',
                                  background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.4), rgba(79, 70, 229, 0.5))',
                                  border: '1px solid rgba(129, 140, 248, 0.6)',
                                  borderRadius: isStart ? '6px 0 0 6px' : '0',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'flex-start',
                                  padding: '0 4px',
                                  overflow: 'hidden',
                                  whiteSpace: 'nowrap',
                                  textOverflow: 'ellipsis',
                                  fontSize: '0.72rem',
                                  fontWeight: 600,
                                  color: '#fff',
                                }}
                                title={`${booking.guestName} (${booking.checkIn} — ${booking.checkOut})${booking.amount ? ` • ${booking.amount} ₽` : ''}`}
                              >
                                {isStart && (
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    👤 {booking.guestName}
                                  </span>
                                )}
                              </div>
                            ) : closure ? (
                              <div
                                style={{
                                  height: '38px',
                                  background: 'rgba(239, 68, 68, 0.15)',
                                  border: '1px dashed rgba(239, 68, 68, 0.4)',
                                  borderRadius: isClosureStart ? '6px 0 0 6px' : '0',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: '0.7rem',
                                  color: 'var(--danger)',
                                }}
                                title={`Закрыто: ${closure.reason || 'Ремонт/Блокировка'}`}
                              >
                                {isClosureStart && '🔒 Закрыто'}
                              </div>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Booking Details Modal */}
      {selectedBooking && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
          onClick={() => setSelectedBooking(null)}
        >
          <div
            className="card"
            style={{
              maxWidth: '440px',
              width: '100%',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-accent)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2>📋 Детали бронирования</h2>
              <button onClick={() => setSelectedBooking(null)} className="btn btn-ghost btn-sm">
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-3" style={{ fontSize: '0.92rem' }}>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Гость:</span>{' '}
                <strong>{selectedBooking.guestName}</strong>
              </div>

              {selectedBooking.guestPhone && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Телефон:</span>{' '}
                  <a href={`tel:${selectedBooking.guestPhone}`}>{selectedBooking.guestPhone}</a>
                </div>
              )}

              <div className="flex gap-4">
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Заезд:</span><br />
                  <strong>{selectedBooking.checkIn}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Выезд:</span><br />
                  <strong>{selectedBooking.checkOut}</strong>
                </div>
              </div>

              {selectedBooking.amount && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Сумма:</span>{' '}
                  <strong style={{ color: 'var(--success)' }}>
                    {selectedBooking.amount.toLocaleString()} ₽
                  </strong>
                </div>
              )}

              <div>
                <span style={{ color: 'var(--text-muted)' }}>Статус:</span>{' '}
                <span className="badge badge-success">{selectedBooking.status}</span>
              </div>

              <div>
                <span style={{ color: 'var(--text-muted)' }}>ID брони:</span>{' '}
                <code>{selectedBooking.id}</code>
              </div>
            </div>

            <div className="mt-6">
              <button onClick={() => setSelectedBooking(null)} className="btn btn-primary w-full">
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
