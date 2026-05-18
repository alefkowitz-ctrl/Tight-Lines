const WX_CODES = {
  0: '☀️', 1: '🌤', 2: '⛅', 3: '☁️',
  45: '🌫', 48: '🌫',
  51: '🌦', 53: '🌦', 55: '🌧',
  61: '🌧', 63: '🌧', 65: '🌧',
  71: '🌨', 73: '🌨', 75: '❄️',
  77: '🌨', 80: '🌦', 81: '🌧', 82: '⛈',
  85: '🌨', 86: '❄️',
  95: '⛈', 96: '⛈', 99: '⛈',
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function WeekForecast({ data }) {
  if (!data?.daily) return null
  const { daily } = data
  const today = new Date().getDay()

  return (
    <div className="forecast-scroll">
      {daily.weathercode.map((code, i) => {
        const date = new Date()
        date.setDate(date.getDate() + i)
        const isToday = i === 0
        return (
          <div key={i} className={`forecast-day ${isToday ? 'today' : ''}`}>
            <div className="forecast-day-name">{isToday ? 'Today' : DAYS[date.getDay()]}</div>
            <div className="forecast-day-icon">{WX_CODES[code] || '🌤'}</div>
            <div className="forecast-day-hi">{Math.round(daily.temperature_2m_max[i])}°</div>
            <div className="forecast-day-lo">{Math.round(daily.temperature_2m_min[i])}°</div>
          </div>
        )
      })}
    </div>
  )
}
