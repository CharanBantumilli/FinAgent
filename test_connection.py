from falkordb import FalkorDB

# Connect to localhost on port 6379
db = FalkorDB(host="localhost", port=6379)

# Select a test graph
g = db.select_graph("test_hackathon")

# Run a simple Cypher query to create a test node
g.query("CREATE (:Person {name: 'Alice', role: 'Builder'})")

# Query it back
result = g.query("MATCH (p:Person) RETURN p.name, p.role")

print("🎉 Successfully connected to FalkorDB Docker container!")
for row in result.result_set:
    print(f"   Found Node -> Name: {row[0]}, Role: {row[1]}")