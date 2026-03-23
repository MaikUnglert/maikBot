import datetime

def escape_markdownv2(text: str) -> str:
    """
    Escapes special MarkdownV2 characters in the given text.
    """
    # Ensure text is a string to avoid issues with replace method on non-string types
    if not isinstance(text, str):
        text = str(text)

    # Escape backslashes first to prevent double-escaping other escape characters
    escaped_text = text.replace('', '')
    
    # Then escape other special characters.
    # The order of replacement matters for some characters (e.g., if '-' is part of a URL,
    # but here we're escaping content, not constructing URLs, so simple replacement is fine).
    for char in r'_*[]()~`>#+-=|{}.!':
        if char != '': # Backslash is already handled
            escaped_text = escaped_text.replace(char, f'\{char}')
    return escaped_text

def format_news(news_items: list[dict], date: datetime.date) -> str:
    """
    Formats a list of news items into a nicely structured Telegram message using MarkdownV2.

    Args:
        news_items: A list of dictionaries, each containing 'time', 'source', and 'title' strings.
        date: The date for the header.

    Returns:
        The final formatted string ready for Telegram's sendMessage API.
    """
    formatted_date = date.strftime("%d\.%m\.%Y")
    header = f"🗞️ *Aktuelle Top\-Nachrichten* \({formatted_date}\)
"

    body_lines = []
    for item in news_items:
        # Escape individual components first
        escaped_time = escape_markdownv2(item.get('time', ''))
        escaped_source = escape_markdownv2(item.get('source', ''))
        escaped_title = escape_markdownv2(item.get('title', ''))

        # Now apply MarkdownV2 formatting. Note that the formatting characters themselves
        # are not escaped here, as they are *intended* for formatting.
        line = (
            f"🕒 {escaped_time} \- __{escaped_source}__ \- *{escaped_title}*"
        )
        body_lines.append(line)

    if body_lines:
        return header + "
" + "
".join(body_lines)
    else:
        return header

if __name__ == "__main__":
    sample_news_items = [
        {"time": "10:00", "source": "Google News", "title": "Breaking News: Market Hits New Highs!"},
        {"time": "11:30", "source": "TechCrunch", "title": "New AI Model 'Gemini' Announced with Exciting Features"},
        {"time": "12:45", "source": "BBC", "title": "World Leaders Discuss Climate Change. 'Urgent Action Needed!'"},
        {"time": "14:00", "source": "Local Gazette", "title": "Community Event: 'Spring Festival' this weekend - don't miss out!"},
        {"time": "15:15", "source": "The Daily Planet", "title": "Hero Saves City! Details at 6:00. Special characters: \ _ * ` [ ] ( ) ~ > # + - = | { } . !"},
        {"time": "16:00", "source": "Financial Times", "title": "Stock prices are up 1.5% today (S&P 500)"},
        {"time": "17:00", "source": "Science Today", "title": "New discovery: Microbes in deep sea vents > expected quantity."}
    ]
    today = datetime.date.today()
    formatted_message = format_news(sample_news_items, today)
    print(formatted_message)
