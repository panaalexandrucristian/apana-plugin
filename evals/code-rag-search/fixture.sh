#!/bin/sh
set -eu
mkdir -p src
cat > src/CartPricing.kt <<'EOT'
package demo
class CartPricing {
    fun finalAmount(lines: List<Pair<Int, Int>>, promoPercent: Int): Int {
        val gross = lines.sumOf { it.first * it.second }
        return gross - gross * promoPercent / 100
    }
}
EOT
cat > src/Logger.kt <<'EOT'
package demo
class Logger { fun info(message: String) = println(message) }
EOT
cat > src/UserSession.kt <<'EOT'
package demo
class UserSession(val token: String) { fun isExpired(now: Long) = now > token.length }
EOT
