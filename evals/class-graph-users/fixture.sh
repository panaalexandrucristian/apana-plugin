#!/bin/sh
set -eu
mkdir -p src
cat > src/OrderRepository.kt <<'EOF'
package demo
class OrderRepository { fun load() = "order" }
EOF
cat > src/OrderService.kt <<'EOF'
package demo
class OrderService(private val repository: OrderRepository) { fun get() = repository.load() }
EOF
cat > src/OrderScreen.kt <<'EOF'
package demo
class OrderScreen(private val service: OrderService) { fun render() = service.get() }
EOF
