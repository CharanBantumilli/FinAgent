# phase1/generate_data.py

import random
from datetime import datetime, timezone
from falkordb import FalkorDB

# ---------------------------------------------------------
# 1. SETUP & CONFIGURATION
# ---------------------------------------------------------
random.seed(42)  # Deterministic generation
db = FalkorDB(host='localhost', port=6379)
graph = db.select_graph("brain")


def current_time():
    return datetime.now(timezone.utc).isoformat()


def make_node(type_label, n_id, name, status='active'):
    return {
        'label': type_label,
        'id': n_id,
        'name': name,
        'source': f"Generated {type_label} data source for {name}",
        'status': status,
        'updated_at': current_time()
    }


# ---------------------------------------------------------
# 2. GENERATE ENTITIES (Enforcing Exact Counts)
# ---------------------------------------------------------
# 6 Teams
teams = [
    make_node('Team', 'tm_payments', 'Payments'),
    make_node('Team', 'tm_frontend', 'Frontend'),
    make_node('Team', 'tm_security', 'Security'),
    make_node('Team', 'tm_devops', 'DevOps'),
    make_node('Team', 'tm_backend', 'Backend'),
    make_node('Team', 'tm_platform', 'Platform')
]

# 30 People (Including planted experts)
people = [
    make_node('Person', 'usr_priya', 'Priya Nair'),  # Expert: Billing Migration
    make_node('Person', 'usr_rahul', 'Rahul'),  # Expert: Frontend Security
    make_node('Person', 'usr_sara', 'Sara')  # Expert: API Gateway
]
for i in range(4, 31):
    people.append(make_node('Person', f'usr_{i}', f'Employee {i}'))

# 10 Projects
projects = [
    make_node('Project', 'prj_billing', 'Billing Upgrade'),
    make_node('Project', 'prj_legacy', 'Legacy Migration')  # Owner changes in simulate step
]
for i in range(3, 11):
    projects.append(make_node('Project', f'prj_{i}', f'Project {i}'))

# 25 Topics
topics = [
    make_node('Topic', 'top_billing_mig', 'Billing Migration'),
    make_node('Topic', 'top_billing_db', 'Billing Database'),
    make_node('Topic', 'top_auth', 'Auth Provider'),
    make_node('Topic', 'top_cicd', 'CI/CD'),
    make_node('Topic', 'top_log', 'Logging'),
    make_node('Topic', 'top_fe_sec', 'Frontend Security'),
    make_node('Topic', 'top_api_gw', 'API Gateway')
]
for i in range(8, 26):
    topics.append(make_node('Topic', f'top_{i}', f'Topic {i}'))

# Generate exact counts for Docs (40), Tickets (60), Chats (30), Decisions (25)
docs = [make_node('Document', f'doc_{i}', f'Doc {i}') for i in range(1, 41)]
tickets = [make_node('Ticket', f'tkt_{i}', f'Ticket {i}') for i in range(1, 61)]
chats = [make_node('ChatThread', f'chat_{i}', f'Chat {i}') for i in range(1, 31)]
decisions = [make_node('Decision', f'dec_{i}', f'Decision {i}') for i in range(1, 26)]

# Special Decision adjustments for Planted Chains
decisions[0].update({'name': 'Use MySQL', 'status': 'superseded'})
decisions[1].update({'name': 'Move to Postgres', 'status': 'superseded'})
decisions[2].update({'name': 'Postgres 16 with pgbouncer', 'status': 'active'})

decisions[3].update({'name': 'Auth0', 'status': 'superseded'})
decisions[4].update({'name': 'Okta', 'status': 'superseded'})
decisions[5].update({'name': 'In-house OAuth', 'status': 'active'})

# ---------------------------------------------------------
# 3. IDEMPOTENT INGESTION (NODES)
# ---------------------------------------------------------
print("Ingesting Nodes...")
for n_list in [teams, people, projects, topics, docs, tickets, chats, decisions]:
    for n in n_list:
        # Dynamic label insertion is cleaner this way in python falkordb
        q = f"""
        MERGE (node:{n['label']} {{id: '{n['id']}'}})
        SET node.name = '{n['name']}', node.source = '{n['source']}', 
            node.status = '{n['status']}', node.updated_at = '{n['updated_at']}'
        """
        graph.query(q)

# ---------------------------------------------------------
# 4. RELATIONSHIP GENERATION & INGESTION
# ---------------------------------------------------------
print("Ingesting Relationships & Planted Facts...")


def merge_edge(src_lbl, src_id, edge_type, tgt_lbl, tgt_id):
    q = f"""
    MATCH (a:{src_lbl} {{id: '{src_id}'}}), (b:{tgt_lbl} {{id: '{tgt_id}'}})
    MERGE (a)-[:{edge_type}]->(b)
    """
    graph.query(q)


# Fact 1: Billing Migration Expert vs Owner
merge_edge('Team', 'tm_payments', 'OWNS', 'Project', 'prj_billing')
merge_edge('Project', 'prj_billing', 'INVOLVES', 'Topic', 'top_billing_mig')
merge_edge('Person', 'usr_priya', 'MEMBER_OF', 'Team', 'tm_frontend')  # Not in Payments
for i in range(0, 5):  # Priya authored many docs & tickets about it
    merge_edge('Person', 'usr_priya', 'AUTHORED', 'Document', docs[i]['id'])
    merge_edge('Document', docs[i]['id'], 'ABOUT', 'Topic', 'top_billing_mig')
    merge_edge('Ticket', tickets[i]['id'], 'ASSIGNED_TO', 'Person', 'usr_priya')
    merge_edge('Ticket', tickets[i]['id'], 'ABOUT', 'Topic', 'top_billing_mig')

# Fact 2: Decision chain "Billing Database" (D3 -> D2 -> D1)
merge_edge('Decision', decisions[2]['id'], 'SUPERSEDES', 'Decision', decisions[1]['id'])
merge_edge('Decision', decisions[1]['id'], 'SUPERSEDES', 'Decision', decisions[0]['id'])
for i in range(0, 3):
    merge_edge('Decision', decisions[i]['id'], 'ABOUT', 'Topic', 'top_billing_db')
    merge_edge('Decision', decisions[i]['id'], 'DOCUMENTED_IN', 'Document', docs[i + 5]['id'])

# Fact 3: 3-deep chain on "Auth Provider" (D6 -> D5 -> D4)
merge_edge('Decision', decisions[5]['id'], 'SUPERSEDES', 'Decision', decisions[4]['id'])
merge_edge('Decision', decisions[4]['id'], 'SUPERSEDES', 'Decision', decisions[3]['id'])
for i in range(3, 6):
    merge_edge('Decision', decisions[i]['id'], 'ABOUT', 'Topic', 'top_auth')

# Fact 4: Two 2-deep chains (CI/CD and Logging)
merge_edge('Decision', decisions[7]['id'], 'SUPERSEDES', 'Decision', decisions[6]['id'])  # CI/CD
merge_edge('Decision', decisions[7]['id'], 'ABOUT', 'Topic', 'top_cicd')
merge_edge('Decision', decisions[6]['id'], 'ABOUT', 'Topic', 'top_cicd')

merge_edge('Decision', decisions[9]['id'], 'SUPERSEDES', 'Decision', decisions[8]['id'])  # Logging
merge_edge('Decision', decisions[9]['id'], 'ABOUT', 'Topic', 'top_log')
merge_edge('Decision', decisions[8]['id'], 'ABOUT', 'Topic', 'top_log')

# Fact 5: Two more experts
merge_edge('Team', 'tm_security', 'OWNS', 'Project', 'prj_3')
merge_edge('Project', 'prj_3', 'INVOLVES', 'Topic', 'top_fe_sec')
merge_edge('Person', 'usr_rahul', 'MEMBER_OF', 'Team', 'tm_frontend')  # Rahul in frontend, expert in security
merge_edge('Person', 'usr_rahul', 'AUTHORED', 'ChatThread', chats[0]['id'])
merge_edge('ChatThread', chats[0]['id'], 'ABOUT', 'Topic', 'top_fe_sec')

merge_edge('Team', 'tm_backend', 'OWNS', 'Project', 'prj_4')
merge_edge('Project', 'prj_4', 'INVOLVES', 'Topic', 'top_api_gw')
merge_edge('Person', 'usr_sara', 'MEMBER_OF', 'Team', 'tm_platform')  # Sara in platform, expert in API GW
merge_edge('Ticket', tickets[10]['id'], 'ASSIGNED_TO', 'Person', 'usr_sara')
merge_edge('Ticket', tickets[10]['id'], 'ABOUT', 'Topic', 'top_api_gw')

# Fact 6 Setup: Project whose owning team changes
merge_edge('Team', 'tm_backend', 'OWNS', 'Project', 'prj_legacy')

# Fill remaining relationships randomly to make graph realistic
for p in people[3:]:
    merge_edge('Person', p['id'], 'MEMBER_OF', 'Team', random.choice(teams)['id'])

print("Data Generation Complete!")


# ---------------------------------------------------------
# 5. SIMULATE CHANGE FUNCTION
# ---------------------------------------------------------
def simulate_change():
    """Simulates a change in knowledge/ownership in the graph to show dynamic updates."""
    print("Simulating Organizational Change...")
    with open("phase1/queries/feature3_simulate_change.cypher", "r") as f:
        q_change = f.read()

    # Change owner of 'Legacy Migration' from Backend to Platform
    res = graph.query(q_change, {
        'project_id': 'prj_legacy',
        'new_team_id': 'tm_platform',
        'timestamp': current_time()
    })
    print("Change applied:", res.result_set)


if __name__ == "__main__":
    simulate_change()