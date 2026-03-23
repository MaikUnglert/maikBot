import unittest
import datetime
from src.telegram_formatter import escape_markdownv2, format_news

class TestTelegramFormatter(unittest.TestCase):

    def test_escape_markdownv2(self):
        # Test cases for each special character
        self.assertEqual(escape_markdownv2("text_with_underscore"), r"text\_with\_underscore")
        self.assertEqual(escape_markdownv2("text*with*asterisk"), r"text\*with\*asterisk")
        self.assertEqual(escape_markdownv2("text[with[bracket"), r"text\[with\[bracket")
        self.assertEqual(escape_markdownv2("text]with]bracket"), r"text\]with\]bracket")
        self.assertEqual(escape_markdownv2("text(with(parenthesis"), r"text\(with\(parenthesis")
        self.assertEqual(escape_markdownv2("text)with)parenthesis"), r"text\)with\)parenthesis")
        self.assertEqual(escape_markdownv2("text~with~tilde"), r"text\~with\~tilde")
        self.assertEqual(escape_markdownv2("text`with`backtick"), r"text\`with\`backtick")
        self.assertEqual(escape_markdownv2("text>with>greater"), r"text\>with\>greater")
        self.assertEqual(escape_markdownv2("text#with#hash"), r"text\#with\#hash")
        self.assertEqual(escape_markdownv2("text+with+plus"), r"text\+with\+plus")
        self.assertEqual(escape_markdownv2("text-with-minus"), r"text\-with\-minus")
        self.assertEqual(escape_markdownv2("text=with=equals"), r"text\=with\=equals")
        self.assertEqual(escape_markdownv2("text|with|pipe"), r"text\|with\|pipe")
        self.assertEqual(escape_markdownv2("text{with{brace"), r"text\{with\{brace")
        self.assertEqual(escape_markdownv2("text}with}brace"), r"text\}with\}brace")
        self.assertEqual(escape_markdownv2("text.with.dot"), r"text\.with\.dot")
        self.assertEqual(escape_markdownv2("text!with!exclamation"), r"text\!with\!exclamation")
        self.assertEqual(escape_markdownv2(r"text\with\backslash"), r"text\\with\\backslash")

        # Test with a string containing multiple special characters
        self.assertEqual(escape_markdownv2("Hello_World! *This* is a test. [Link](url)."),
                         r"Hello\_World\! \*This\* is a test\. \[Link\]\(url\)\.")
        # Test with a string that has no special characters
        self.assertEqual(escape_markdownv2("Normal text without special characters"),
                         "Normal text without special characters")
        # Test with an empty string
        self.assertEqual(escape_markdownv2(""), "")

    def test_format_news(self):
        sample_news_items = [
            {"time": "10:00", "source": "Google News", "title": "Breaking News: Market Hits New Highs!"},
            {"time": "11:30", "source": "TechCrunch", "title": "New AI Model 'Gemini' Announced with Exciting Features. (It's _awesome_)"},
            {"time": "12:45", "source": "BBC", "title": "World Leaders Discuss Climate Change. 'Urgent Action Needed!' [Read More]"},
            {"time": "13:00", "source": "Finance Today", "title": "Stocks are up by +1.5% today."},
            {"time": "14:00", "source": "Science! Weekly", "title": "New discovery > 100,000 possibilities."},
            {"time": "15:00", "source": "Blog - John Doe", "title": "My personal thoughts on the future of AI. - Part 1"}
        ]
        test_date = datetime.date(2023, 10, 27) # Fixed date for consistent testing

        expected_output = r"""🗞️ \*Aktuelle Top\-Nachrichten\* \(27\.10\.2023\)
🕒 10\:00 \- \_\_Google News\_\_ \- \*Breaking News\: Market Hits New Highs\!\*
🕒 11\:30 \- \_\_TechCrunch\_\_ \- \*New AI Model 'Gemini' Announced with Exciting Features\. \(It's \_awesome\_\)\*
🕒 12\:45 \- \_\_BBC\_\_ \- \*World Leaders Discuss Climate Change\. 'Urgent Action Needed\!' \[Read More\]\*
🕒 13\:00 \- \_\_Finance Today\_\_ \- \*Stocks are up by \+1\.5\% today\.\*
🕒 14\:00 \- \_\_Science\! Weekly\_\_ \- \*New discovery \> 100\,000 possibilities\.\*
🕒 15\:00 \- \_\_Blog \- John Doe\_\_ \- \*My personal thoughts on the future of AI\. \- Part 1\*"""
        
        # Adjusting the expected output for the header date format is now handled by the raw string.
        # The formatted_header_date is correctly `27\.10\.2023`
        # The expected_output already contains `\(27\.10\.2023\)`
        
        self.assertEqual(format_news(sample_news_items, test_date), expected_output)

        
        # Test with empty news items list
        # Re-calculating formatted_header_date for clarity and correct scope
        formatted_header_date_for_empty = test_date.strftime(r"%d\.%m\.%Y")
        self.assertEqual(format_news([], test_date),
                         f"🗞️ *Aktuelle Top\\-Nachrichten* \\({formatted_header_date_for_empty}\\)")

if __name__ == '__main__':
    unittest.main()
