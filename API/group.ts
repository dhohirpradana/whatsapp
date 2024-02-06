const createGroup = async (name: string, members: string[], sock) => {
    const group = await sock.createGroup(name, members);
    return group;
};

const deleteGroup = async (groupId: string, sock) => {
    await sock.deleteGroup(groupId);
};

export default createGroup;